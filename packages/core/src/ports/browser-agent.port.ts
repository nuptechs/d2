// ============================================================
// BrowserAgentPort — Abstraction for browser automation
// Adapters: Playwright, Puppeteer, Selenium (future)
// ============================================================

import type {
  BrowserConfig,
  BrowserEvent,
  ClickEvent,
  NavigationEvent,
  ScreenshotEvent,
  ScreenshotTrigger,
  DomSnapshotEvent,
  InputEvent,
} from '../types/index.js';

export abstract class BrowserAgentPort {
  // ---- Lifecycle ----
  abstract launch(config: BrowserConfig): Promise<void>;
  abstract close(): Promise<void>;
  abstract isLaunched(): boolean;

  // ---- Capture ----
  abstract screenshot(trigger?: ScreenshotTrigger, label?: string): Promise<ScreenshotEvent>;
  abstract domSnapshot(): Promise<DomSnapshotEvent>;

  // ---- Navigation ----
  abstract navigate(url: string): Promise<NavigationEvent>;
  abstract currentUrl(): string;
  abstract goBack(): Promise<NavigationEvent>;
  abstract reload(): Promise<NavigationEvent>;

  // ---- Interaction ----
  abstract click(selector: string): Promise<ClickEvent>;
  abstract type(selector: string, text: string, options?: { masked?: boolean }): Promise<InputEvent>;
  abstract select(selector: string, value: string): Promise<void>;
  abstract hover(selector: string): Promise<void>;

  // ---- Waiting ----
  abstract waitForSelector(selector: string, timeout?: number): Promise<void>;
  abstract waitForNavigation(timeout?: number): Promise<NavigationEvent>;
  abstract waitForNetworkIdle(timeout?: number): Promise<void>;

  // ---- Evaluation ----
  abstract evaluate<T>(expression: string): Promise<T>;

  // ---- Event subscription ----
  abstract onEvent(handler: (event: BrowserEvent) => void): () => void;
}
