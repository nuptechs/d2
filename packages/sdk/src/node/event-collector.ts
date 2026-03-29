// ============================================================
// SDK Event Collector — Central event collection for Node SDK
// Buffers events until a handler is registered
// ============================================================

import type { SdkEvent } from '@probe/core';
import { generateId, nowMs } from '@probe/core';

type PartialEvent = Omit<SdkEvent, 'id' | 'sessionId' | 'timestamp' | 'source'> & Record<string, unknown>;
type EventHandler = (event: SdkEvent) => void;

export class SdkEventCollector {
  private sessionId = '';
  private handlers: EventHandler[] = [];
  private buffer: SdkEvent[] = [];
  private stats = { total: 0, byType: {} as Record<string, number> };

  /** Set the session ID applied to all emitted events */
  setSessionId(id: string): void {
    this.sessionId = id;
  }

  /** Emit an event — wraps with id, sessionId, timestamp, source */
  emit(partial: PartialEvent): void {
    const event: SdkEvent = {
      ...partial,
      id: generateId(),
      sessionId: this.sessionId,
      timestamp: nowMs(),
      source: 'sdk',
    } as SdkEvent;

    this.stats.total++;
    const typeName = (event as { type?: string }).type ?? 'unknown';
    this.stats.byType[typeName] = (this.stats.byType[typeName] ?? 0) + 1;

    if (this.handlers.length === 0) {
      this.buffer.push(event);
      return;
    }

    for (const handler of this.handlers) {
      handler(event);
    }
  }

  /** Register an event handler. Flushes any buffered events immediately. */
  onEvent(handler: EventHandler): () => void {
    this.handlers.push(handler);

    // Flush buffer to new handler
    if (this.buffer.length > 0) {
      const buffered = this.buffer.splice(0);
      for (const event of buffered) {
        handler(event);
      }
    }

    return () => {
      const idx = this.handlers.indexOf(handler);
      if (idx >= 0) this.handlers.splice(idx, 1);
    };
  }

  /** Return and clear all buffered events */
  flush(): SdkEvent[] {
    const events = this.buffer.splice(0);
    return events;
  }

  /** Get emission statistics */
  getStats(): { total: number; byType: Record<string, number> } {
    return { total: this.stats.total, byType: { ...this.stats.byType } };
  }

  /** Reset collector state */
  reset(): void {
    this.buffer.length = 0;
    this.handlers.length = 0;
    this.stats = { total: 0, byType: {} };
    this.sessionId = '';
  }
}
