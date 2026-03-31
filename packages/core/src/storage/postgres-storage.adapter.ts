// ============================================================
// PostgreSQL Storage Adapter — Persistent session & event storage
// Implements StoragePort with proper schema, indexes, and JSONB
// ============================================================

import type { DebugSession, ProbeEvent } from '../types/index.js';
import { StoragePort, type EventFilter } from '../ports/storage.port.js';

// pg types — dynamically imported to keep it optional
type Pool = import('pg').Pool;
type PoolConfig = import('pg').PoolConfig;

export interface PostgresStorageConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  maxConnections?: number;
  ssl?: boolean | object;
}

export class PostgresStorageAdapter extends StoragePort {
  private pool: Pool | null = null;
  private readonly config: PostgresStorageConfig;

  constructor(config: PostgresStorageConfig) {
    super();
    this.config = config;
  }

  async initialize(): Promise<void> {
    // Dynamic import — pg is an optional dependency
    const { default: pg } = await import('pg');

    const poolConfig: PoolConfig = {
      max: this.config.maxConnections ?? 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 30_000,    // Kill queries after 30s
      query_timeout: 30_000,        // Client-side query timeout
    } as PoolConfig;

    if (this.config.connectionString) {
      poolConfig.connectionString = this.config.connectionString;
    } else {
      poolConfig.host = this.config.host ?? 'localhost';
      poolConfig.port = this.config.port ?? 5432;
      poolConfig.database = this.config.database ?? 'debug_probe';
      poolConfig.user = this.config.user ?? 'probe';
      poolConfig.password = this.config.password;
    }

    if (this.config.ssl) {
      poolConfig.ssl = typeof this.config.ssl === 'object'
        ? this.config.ssl
        : { rejectUnauthorized: false };
    }

    this.pool = new pg.Pool(poolConfig);

    // Verify connection
    const client = await this.pool.connect();
    try {
      await client.query('SELECT 1');
    } finally {
      client.release();
    }

    await this.runMigrations();
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  // ---- Schema Migrations ----

  private async runMigrations(): Promise<void> {
    const pool = this.getPool();

    await pool.query(`
      CREATE TABLE IF NOT EXISTS probe_migrations (
        id SERIAL PRIMARY KEY,
        version INTEGER NOT NULL UNIQUE,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const { rows } = await pool.query<{ version: number }>(
      'SELECT COALESCE(MAX(version), 0) AS version FROM probe_migrations'
    );
    const currentVersion = rows[0]?.version ?? 0;

    for (const migration of MIGRATIONS) {
      if (migration.version > currentVersion) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(migration.sql);
          await client.query(
            'INSERT INTO probe_migrations (version, name) VALUES ($1, $2)',
            [migration.version, migration.name]
          );
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
      }
    }
  }

  // ---- Session CRUD ----

  async saveSession(session: DebugSession): Promise<void> {
    const pool = this.getPool();
    await pool.query(
      `INSERT INTO probe_sessions (id, name, status, config, started_at, ended_at, event_count, error_message, tags, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         status = EXCLUDED.status,
         config = EXCLUDED.config,
         started_at = EXCLUDED.started_at,
         ended_at = EXCLUDED.ended_at,
         event_count = EXCLUDED.event_count,
         error_message = EXCLUDED.error_message,
         tags = EXCLUDED.tags,
         metadata = EXCLUDED.metadata`,
      [
        session.id,
        session.name,
        session.status,
        JSON.stringify(session.config),
        session.startedAt,
        session.endedAt ?? null,
        session.eventCount,
        session.errorMessage ?? null,
        session.tags ?? null,
        session.metadata ? JSON.stringify(session.metadata) : null,
      ],
    );
  }

  async loadSession(id: string): Promise<DebugSession | null> {
    const pool = this.getPool();
    const { rows } = await pool.query(
      'SELECT * FROM probe_sessions WHERE id = $1',
      [id],
    );
    if (rows.length === 0) return null;
    return this.rowToSession(rows[0]);
  }

  async listSessions(): Promise<DebugSession[]> {
    const pool = this.getPool();
    const { rows } = await pool.query(
      'SELECT * FROM probe_sessions ORDER BY started_at DESC',
    );
    return rows.map((r: Record<string, unknown>) => this.rowToSession(r));
  }

  async deleteSession(id: string): Promise<void> {
    const pool = this.getPool();
    // Events are cascaded via FK
    await pool.query('DELETE FROM probe_sessions WHERE id = $1', [id]);
  }

  async updateSessionStatus(
    id: string,
    status: DebugSession['status'],
    patch?: Partial<DebugSession>,
  ): Promise<void> {
    const pool = this.getPool();
    const endedAt = (status === 'completed' || status === 'error')
      ? Date.now()
      : null;

    if (patch) {
      await pool.query(
        `UPDATE probe_sessions SET
           status = $2,
           ended_at = COALESCE($3, ended_at),
           name = COALESCE($4, name),
           error_message = COALESCE($5, error_message),
           event_count = COALESCE($6, event_count),
           tags = COALESCE($7, tags),
           metadata = COALESCE($8, metadata)
         WHERE id = $1`,
        [
          id,
          status,
          endedAt,
          patch.name ?? null,
          patch.errorMessage ?? null,
          patch.eventCount ?? null,
          patch.tags ?? null,
          patch.metadata ? JSON.stringify(patch.metadata) : null,
        ],
      );
    } else {
      await pool.query(
        'UPDATE probe_sessions SET status = $2, ended_at = COALESCE($3, ended_at) WHERE id = $1',
        [id, status, endedAt],
      );
    }
  }

  // ---- Event Storage ----

  async appendEvent(sessionId: string, event: ProbeEvent): Promise<void> {
    await this.appendEvents(sessionId, [event]);
  }

  async appendEvents(sessionId: string, events: ProbeEvent[]): Promise<void> {
    if (events.length === 0) return;
    const pool = this.getPool();

    // Batch insert with a single query using unnest
    const ids: string[] = [];
    const sessionIds: string[] = [];
    const timestamps: number[] = [];
    const sources: string[] = [];
    const types: string[] = [];
    const correlationIds: (string | null)[] = [];
    const payloads: string[] = [];

    for (const event of events) {
      ids.push(event.id);
      sessionIds.push(sessionId);
      timestamps.push(event.timestamp);
      sources.push(event.source);
      types.push((event as unknown as Record<string, unknown>)['type'] as string ?? 'unknown');
      correlationIds.push(event.correlationId ?? null);
      payloads.push(JSON.stringify(event));
    }

    await pool.query(
      `INSERT INTO probe_events (id, session_id, timestamp, source, type, correlation_id, payload)
       SELECT * FROM UNNEST($1::text[], $2::text[], $3::bigint[], $4::text[], $5::text[], $6::text[], $7::jsonb[])
       ON CONFLICT (id) DO NOTHING`,
      [ids, sessionIds, timestamps, sources, types, correlationIds, payloads],
    );

    // Update event count on session
    await pool.query(
      `UPDATE probe_sessions SET event_count = (
        SELECT COUNT(*) FROM probe_events WHERE session_id = $1
       ) WHERE id = $1`,
      [sessionId],
    );
  }

  async getEvents(sessionId: string, filter?: EventFilter): Promise<ProbeEvent[]> {
    const pool = this.getPool();
    const conditions: string[] = ['session_id = $1'];
    const params: unknown[] = [sessionId];
    let paramIdx = 2;

    if (filter?.source && filter.source.length > 0) {
      conditions.push(`source = ANY($${paramIdx})`);
      params.push(filter.source);
      paramIdx++;
    }
    if (filter?.types && filter.types.length > 0) {
      conditions.push(`type = ANY($${paramIdx})`);
      params.push(filter.types);
      paramIdx++;
    }
    if (filter?.fromTime != null) {
      conditions.push(`timestamp >= $${paramIdx}`);
      params.push(filter.fromTime);
      paramIdx++;
    }
    if (filter?.toTime != null) {
      conditions.push(`timestamp <= $${paramIdx}`);
      params.push(filter.toTime);
      paramIdx++;
    }
    if (filter?.correlationId) {
      conditions.push(`correlation_id = $${paramIdx}`);
      params.push(filter.correlationId);
      paramIdx++;
    }

    const limit = filter?.limit ?? 500;
    const offset = filter?.offset ?? 0;

    const sql = `
      SELECT payload FROM probe_events
      WHERE ${conditions.join(' AND ')}
      ORDER BY timestamp ASC
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
    `;
    params.push(limit, offset);

    const { rows } = await pool.query(sql, params);
    return rows.map((r: Record<string, unknown>) => r.payload as unknown as ProbeEvent);
  }

  async getEventCount(sessionId: string): Promise<number> {
    const pool = this.getPool();
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM probe_events WHERE session_id = $1',
      [sessionId],
    );
    return rows[0]?.count ?? 0;
  }

  // ---- Extended Query Methods (for API pagination) ----

  async listSessionsPaginated(opts: {
    limit?: number;
    offset?: number;
    status?: string;
    search?: string;
    orderBy?: string;
    order?: 'asc' | 'desc';
  }): Promise<{ sessions: DebugSession[]; total: number }> {
    const pool = this.getPool();
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (opts.status) {
      conditions.push(`status = $${paramIdx}`);
      params.push(opts.status);
      paramIdx++;
    }
    if (opts.search) {
      conditions.push(`name ILIKE $${paramIdx}`);
      params.push(`%${opts.search}%`);
      paramIdx++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const allowedOrderColumns: Record<string, string> = {
      started_at: 'started_at',
      event_count: 'event_count',
      name: 'name',
      status: 'status',
    };
    const orderCol = allowedOrderColumns[opts.orderBy ?? 'started_at'] ?? 'started_at';
    const orderDir = opts.order === 'asc' ? 'ASC' : 'DESC';

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM probe_sessions ${where}`,
      params,
    );

    const limit = Math.min(opts.limit ?? 50, 200);
    const offset = opts.offset ?? 0;

    const dataResult = await pool.query(
      `SELECT * FROM probe_sessions ${where} ORDER BY ${orderCol} ${orderDir} LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limit, offset],
    );

    return {
      sessions: dataResult.rows.map((r: Record<string, unknown>) => this.rowToSession(r)),
      total: countResult.rows[0]?.total ?? 0,
    };
  }

  async getEventsWithTotal(sessionId: string, filter?: EventFilter): Promise<{ events: ProbeEvent[]; total: number }> {
    const pool = this.getPool();
    const conditions: string[] = ['session_id = $1'];
    const params: unknown[] = [sessionId];
    let paramIdx = 2;

    if (filter?.source && filter.source.length > 0) {
      conditions.push(`source = ANY($${paramIdx})`);
      params.push(filter.source);
      paramIdx++;
    }
    if (filter?.types && filter.types.length > 0) {
      conditions.push(`type = ANY($${paramIdx})`);
      params.push(filter.types);
      paramIdx++;
    }
    if (filter?.fromTime != null) {
      conditions.push(`timestamp >= $${paramIdx}`);
      params.push(filter.fromTime);
      paramIdx++;
    }
    if (filter?.toTime != null) {
      conditions.push(`timestamp <= $${paramIdx}`);
      params.push(filter.toTime);
      paramIdx++;
    }
    if (filter?.correlationId) {
      conditions.push(`correlation_id = $${paramIdx}`);
      params.push(filter.correlationId);
      paramIdx++;
    }

    const where = conditions.join(' AND ');

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM probe_events WHERE ${where}`,
      params,
    );

    const limit = filter?.limit ?? 500;
    const offset = filter?.offset ?? 0;

    const dataResult = await pool.query(
      `SELECT payload FROM probe_events WHERE ${where} ORDER BY timestamp ASC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limit, offset],
    );

    return {
      events: dataResult.rows.map((r: Record<string, unknown>) => r.payload as unknown as ProbeEvent),
      total: countResult.rows[0]?.total ?? 0,
    };
  }

  // ---- Internal Helpers ----

  private getPool(): Pool {
    if (!this.pool) throw new Error('PostgresStorageAdapter not initialized. Call initialize() first.');
    return this.pool;
  }

  private rowToSession(row: Record<string, unknown>): DebugSession {
    return {
      id: row.id as string,
      name: row.name as string,
      status: row.status as DebugSession['status'],
      config: (typeof row.config === 'string' ? JSON.parse(row.config) : row.config) as DebugSession['config'],
      startedAt: Number(row.started_at),
      endedAt: row.ended_at ? Number(row.ended_at) : undefined,
      eventCount: Number(row.event_count),
      errorMessage: row.error_message as string | undefined,
      tags: row.tags as string[] | undefined,
      metadata: row.metadata as Record<string, unknown> | undefined,
    };
  }
}

// ---- Migrations ----

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      -- Sessions table
      CREATE TABLE IF NOT EXISTS probe_sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        config JSONB NOT NULL DEFAULT '{}',
        started_at BIGINT NOT NULL,
        ended_at BIGINT,
        event_count INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        tags TEXT[],
        metadata JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Events table (high volume — optimized for write + range queries)
      CREATE TABLE IF NOT EXISTS probe_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES probe_sessions(id) ON DELETE CASCADE,
        timestamp BIGINT NOT NULL,
        source TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'unknown',
        correlation_id TEXT,
        payload JSONB NOT NULL
      );

      -- Indexes for query patterns
      CREATE INDEX IF NOT EXISTS idx_events_session_ts ON probe_events (session_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_session_source ON probe_events (session_id, source);
      CREATE INDEX IF NOT EXISTS idx_events_session_type ON probe_events (session_id, type);
      CREATE INDEX IF NOT EXISTS idx_events_correlation ON probe_events (correlation_id) WHERE correlation_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON probe_sessions (status);
      CREATE INDEX IF NOT EXISTS idx_sessions_started ON probe_sessions (started_at DESC);
    `,
  },
];
