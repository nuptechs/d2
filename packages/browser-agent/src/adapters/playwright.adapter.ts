import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import {
  BrowserAgentPort,
  generateId,
  generateSessionId,
  nowMs,
} from '@probe/core';
import type {
  BrowserConfig,
  BrowserEvent,
  ClickEvent,
  ConsoleEvent,
  BrowserErrorEvent,
  DomSnapshotEvent,
  InputEvent,
  NavigationEvent,
  ScreenshotEvent,
  ScreenshotTrigger,
} from '@probe/core';

export class PlaywrightBrowserAdapter extends BrowserAgentPort {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private sessionId = '';
  private config: BrowserConfig | null = null;
  private handlers = new Set<(event: BrowserEvent) => void>();
  private periodicInterval: ReturnType<typeof setInterval> | null = null;

  // ---- Lifecycle ----

  async launch(config: BrowserConfig): Promise<void> {
    if (this.browser) {
      throw new Error('PlaywrightBrowserAdapter: browser already launched. Call close() first.');
    }

    this.config = config;
    this.sessionId = generateSessionId();

    this.browser = await chromium.launch({
      headless: config.headless ?? true,
    });

    this.context = await this.browser.newContext({
      viewport: config.viewport ?? { width: 1280, height: 720 },
      userAgent: config.userAgent,
    });

    if (config.cookies?.length) {
      await this.context.addCookies(
        config.cookies.map((c) => ({ ...c, path: '/' })),
      );
    }

    this.page = await this.context.newPage();
    this.attachPageListeners(this.page);

    if (config.targetUrl) {
      await this.page.goto(config.targetUrl, { waitUntil: 'domcontentloaded' });
    }

    if (config.screenshotInterval && config.screenshotInterval > 0) {
      this.periodicInterval = setInterval(() => {
        void this.screenshot('periodic', 'periodic-capture').catch(() => {
          /* swallow — page may have closed */
        });
      }, config.screenshotInterval);
    }
  }

  async close(): Promise<void> {
    if (this.periodicInterval) {
      clearInterval(this.periodicInterval);
      this.periodicInterval = null;
    }
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
    this.page = null;
    this.handlers.clear();
  }

  isLaunched(): boolean {
    return this.browser !== null && this.page !== null;
  }

  // ---- Capture ----

  async screenshot(
    trigger: ScreenshotTrigger = 'manual',
    label?: string,
  ): Promise<ScreenshotEvent> {
    const page = this.requirePage();
    const buffer = await page.screenshot({ type: 'png', fullPage: false });
    const viewport = page.viewportSize() ?? { width: 0, height: 0 };

    const event: ScreenshotEvent = {
      id: generateId(),
      sessionId: this.sessionId,
      timestamp: nowMs(),
      source: 'browser',
      type: 'screenshot',
      pageUrl: page.url(),
      data: buffer.toString('base64'),
      viewport: { width: viewport.width, height: viewport.height },
      trigger,
      label,
    };

    this.emit(event);
    return event;
  }

  async domSnapshot(): Promise<DomSnapshotEvent> {
    const page = this.requirePage();
    const html = await page.content();

    const event: DomSnapshotEvent = {
      id: generateId(),
      sessionId: this.sessionId,
      timestamp: nowMs(),
      source: 'browser',
      type: 'dom-snapshot',
      pageUrl: page.url(),
      html,
    };

    this.emit(event);
    return event;
  }

  // ---- Navigation ----

  async navigate(url: string): Promise<NavigationEvent> {
    const page = this.requirePage();
    const fromUrl = page.url();
    const start = nowMs();

    await page.goto(url, { waitUntil: 'domcontentloaded' });

    const event: NavigationEvent = {
      id: generateId(),
      sessionId: this.sessionId,
      timestamp: nowMs(),
      source: 'browser',
      type: 'navigation',
      pageUrl: page.url(),
      fromUrl,
      toUrl: page.url(),
      timing: { domContentLoaded: nowMs() - start },
    };

    this.emit(event);
    return event;
  }

  currentUrl(): string {
    return this.requirePage().url();
  }

  async goBack(): Promise<NavigationEvent> {
    const page = this.requirePage();
    const fromUrl = page.url();

    await page.goBack({ waitUntil: 'domcontentloaded' });

    const event: NavigationEvent = {
      id: generateId(),
      sessionId: this.sessionId,
      timestamp: nowMs(),
      source: 'browser',
      type: 'navigation',
      pageUrl: page.url(),
      fromUrl,
      toUrl: page.url(),
    };

    this.emit(event);
    return event;
  }

  async reload(): Promise<NavigationEvent> {
    const page = this.requirePage();
    const url = page.url();

    await page.reload({ waitUntil: 'domcontentloaded' });

    const event: NavigationEvent = {
      id: generateId(),
      sessionId: this.sessionId,
      timestamp: nowMs(),
      source: 'browser',
      type: 'navigation',
      pageUrl: page.url(),
      fromUrl: url,
      toUrl: page.url(),
    };

    this.emit(event);
    return event;
  }

  // ---- Interaction ----

  async click(selector: string): Promise<ClickEvent> {
    const page = this.requirePage();

    if (this.config?.screenshotOnAction) {
      await this.screenshot('pre-action', `before-click:${selector}`);
    }

    const handle = await page.$(selector);
    if (!handle) {
      throw new Error(`PlaywrightBrowserAdapter.click: selector "${selector}" not found`);
    }

    const tagName = await handle.evaluate((el) => el.tagName.toLowerCase());
    const textContent = await handle.evaluate((el) => el.textContent?.trim().slice(0, 120) ?? '');
    const box = await handle.boundingBox();

    await handle.click();

    const event: ClickEvent = {
      id: generateId(),
      sessionId: this.sessionId,
      timestamp: nowMs(),
      source: 'browser',
      type: 'click',
      pageUrl: page.url(),
      selector,
      elementTag: tagName,
      elementText: textContent || undefined,
      coordinates: { x: box?.x ?? 0, y: box?.y ?? 0 },
    };

    this.emit(event);

    if (this.config?.screenshotOnAction) {
      await this.screenshot('post-action', `after-click:${selector}`);
    }

    return event;
  }

  async type(
    selector: string,
    text: string,
    options?: { masked?: boolean },
  ): Promise<InputEvent> {
    const page = this.requirePage();
    const masked = options?.masked ?? false;

    const handle = await page.$(selector);
    if (!handle) {
      throw new Error(`PlaywrightBrowserAdapter.type: selector "${selector}" not found`);
    }

    const tagName = await handle.evaluate((el) => el.tagName.toLowerCase());
    const inputType = await handle.evaluate((el) =>
      el.tagName === 'INPUT' ? el.getAttribute('type') ?? undefined : undefined,
    );

    await handle.fill(text);

    const event: InputEvent = {
      id: generateId(),
      sessionId: this.sessionId,
      timestamp: nowMs(),
      source: 'browser',
      type: 'input',
      pageUrl: page.url(),
      selector,
      elementTag: tagName,
      inputType,
      value: masked ? '***' : text,
      masked,
    };

    this.emit(event);
    return event;
  }

  async select(selector: string, value: string): Promise<void> {
    const page = this.requirePage();
    await page.selectOption(selector, value);
  }

  async hover(selector: string): Promise<void> {
    const page = this.requirePage();
    await page.hover(selector);
  }

  // ---- Waiting ----

  async waitForSelector(selector: string, timeout = 30_000): Promise<void> {
    const page = this.requirePage();
    await page.waitForSelector(selector, { timeout });
  }

  async waitForNavigation(timeout = 30_000): Promise<NavigationEvent> {
    const page = this.requirePage();
    const fromUrl = page.url();

    await page.waitForNavigation({ timeout, waitUntil: 'domcontentloaded' });

    const event: NavigationEvent = {
      id: generateId(),
      sessionId: this.sessionId,
      timestamp: nowMs(),
      source: 'browser',
      type: 'navigation',
      pageUrl: page.url(),
      fromUrl,
      toUrl: page.url(),
    };

    this.emit(event);
    return event;
  }

  async waitForNetworkIdle(timeout = 30_000): Promise<void> {
    const page = this.requirePage();
    await page.waitForLoadState('networkidle', { timeout });
  }

  // ---- Evaluation ----

  async evaluate<T>(expression: string): Promise<T> {
    const page = this.requirePage();
    return page.evaluate(expression) as Promise<T>;
  }

  // ---- Event subscription ----

  onEvent(handler: (event: BrowserEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  // ---- Private helpers ----

  private requirePage(): Page {
    if (!this.page) {
      throw new Error('PlaywrightBrowserAdapter: browser not launched. Call launch() first.');
    }
    return this.page;
  }

  private emit(event: BrowserEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        /* handler errors must not break the adapter */
      }
    }
  }

  private attachPageListeners(page: Page): void {
    if (this.config?.captureConsole) {
      page.on('console', (msg) => {
        const level = msg.type() as ConsoleEvent['level'];
        const validLevels = new Set(['log', 'warn', 'error', 'info', 'debug']);
        if (!validLevels.has(level)) return;

        const event: ConsoleEvent = {
          id: generateId(),
          sessionId: this.sessionId,
          timestamp: nowMs(),
          source: 'browser',
          type: 'console',
          pageUrl: page.url(),
          level,
          message: msg.text(),
        };
        this.emit(event);
      });
    }

    page.on('pageerror', (error) => {
      const event: BrowserErrorEvent = {
        id: generateId(),
        sessionId: this.sessionId,
        timestamp: nowMs(),
        source: 'browser',
        type: 'error',
        pageUrl: page.url(),
        errorType: 'uncaught',
        message: error.message,
        stack: error.stack,
      };
      this.emit(event);
    });
  }
}
