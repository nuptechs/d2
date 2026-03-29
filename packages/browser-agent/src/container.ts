import type { BrowserAgentPort } from '@probe/core';
import { PlaywrightBrowserAdapter } from './adapters/playwright.adapter.js';

let _agent: BrowserAgentPort | null = null;

export function getBrowserAgent(): BrowserAgentPort {
  if (!_agent) {
    _agent = new PlaywrightBrowserAdapter();
  }
  return _agent;
}

export function resetBrowserAgent(): void {
  _agent = null;
}
