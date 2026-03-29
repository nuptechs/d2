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
      fileConfig = JSON.parse(raw) as Partial<ProbeConfig>;
    } catch {
      // Ignore parse errors on config — use defaults
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
    merged.session.network = {
      ...(merged.session.network ?? { enabled: true, mode: 'proxy' as const, captureBody: true }),
      proxyPort: parseInt(envPort, 10),
    };
  }

  const envOutput = process.env['PROBE_OUTPUT_DIR'];
  if (envOutput) {
    merged.outputDir = envOutput;
  }

  return merged;
}
