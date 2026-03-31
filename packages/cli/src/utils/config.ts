// ============================================================
// CLI config loading — .proberc.json + env var overrides
// ============================================================

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProbeConfig } from '@probe/core';
import { DEFAULT_PROBE_CONFIG, DEFAULT_SERVER_CONFIG, DEFAULT_STORAGE_CONFIG } from '@probe/core';

export function loadConfig(configPath?: string): ProbeConfig {
  const resolvedPath = resolve(process.cwd(), configPath ?? '.proberc.json');

  let fileConfig: Partial<ProbeConfig> = {};
  if (existsSync(resolvedPath)) {
    try {
      const raw = readFileSync(resolvedPath, 'utf-8');
      const parsed = JSON.parse(raw);
      // Structural validation — reject non-object or __proto__ pollution attempts
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        console.warn(`Warning: Config in ${resolvedPath} must be a JSON object. Using defaults.`);
      } else if ('__proto__' in parsed || 'constructor' in parsed || 'prototype' in parsed) {
        console.warn(`Warning: Config in ${resolvedPath} contains prohibited keys. Using defaults.`);
      } else {
        fileConfig = parsed as Partial<ProbeConfig>;
      }
    } catch (err) {
      console.warn(`Warning: Failed to parse ${resolvedPath}: ${(err as Error).message}`);
      console.warn('Using default configuration.');
    }
  }

  const merged: ProbeConfig = {
    ...DEFAULT_PROBE_CONFIG,
    ...fileConfig,
    session: {
      ...DEFAULT_PROBE_CONFIG.session,
      ...fileConfig.session,
    },
    server: {
      ...DEFAULT_SERVER_CONFIG,
      ...fileConfig.server,
    },
    storage: {
      ...DEFAULT_STORAGE_CONFIG,
      ...fileConfig.storage,
    },
  };

  // Environment variable overrides
  const envUrl = process.env['PROBE_TARGET_URL'];
  if (envUrl) {
    merged.session.browser = {
      ...(merged.session.browser ?? { enabled: true, targetUrl: envUrl, screenshotOnAction: true, captureConsole: true, captureDom: false }),
      targetUrl: envUrl,
    };
  }

  const envPort = process.env['PROBE_PROXY_PORT'];
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (Number.isNaN(parsed) || parsed < 1 || parsed > 65535) {
      console.warn(`Warning: Invalid PROBE_PROXY_PORT "${envPort}" — using default.`);
    } else {
      merged.session.network = {
        ...(merged.session.network ?? { enabled: true, mode: 'proxy' as const, captureBody: true }),
        proxyPort: parsed,
      };
    }
  }

  const envOutput = process.env['PROBE_OUTPUT_DIR'];
  if (envOutput) {
    merged.outputDir = envOutput;
  }

  return merged;
}
