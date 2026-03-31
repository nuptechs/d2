// ============================================================
// EventBus — In-memory pub/sub for decoupling probe components
// Thread-safe, supports wildcard subscriptions and cleanup
// ============================================================

import type { ProbeEvent } from '../types/index.js';

export type EventHandler<T extends ProbeEvent = ProbeEvent> = (event: T) => void;

export type EventBusErrorHandler = (context: string, err: unknown) => void;

const defaultErrorHandler: EventBusErrorHandler = (context, err) => {
  console.error(`[EventBus] ${context}`, err);
};

export class EventBus {
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private readonly wildcardHandlers = new Set<EventHandler>();
  private _emitCount = 0;
  private _onError: EventBusErrorHandler = defaultErrorHandler;

  /** Set a custom error handler (e.g. pino logger) */
  setErrorHandler(handler: EventBusErrorHandler): void {
    this._onError = handler;
  }

  /** Subscribe to events of a specific type (e.g., 'browser:click', 'network:request') */
  on<T extends ProbeEvent = ProbeEvent>(eventType: string, handler: EventHandler<T>): () => void {
    let set = this.handlers.get(eventType);
    if (!set) {
      set = new Set();
      this.handlers.set(eventType, set);
    }
    set.add(handler as EventHandler);
    return () => this.off(eventType, handler as EventHandler);
  }

  /** Unsubscribe from a specific event type */
  off(eventType: string, handler: EventHandler): void {
    const set = this.handlers.get(eventType);
    if (set) {
      set.delete(handler);
      if (set.size === 0) this.handlers.delete(eventType);
    }
  }

  /** Subscribe to ALL events regardless of type */
  onAny(handler: EventHandler): () => void {
    this.wildcardHandlers.add(handler);
    return () => this.wildcardHandlers.delete(handler);
  }

  /** Emit an event to all matching subscribers */
  emit(eventType: string, event: ProbeEvent): void {
    this._emitCount++;

    const handlers = this.handlers.get(eventType);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (err) {
          this._onError(`Handler error for "${eventType}"`, err);
        }
      }
    }

    // Also emit to source-level subscribers (e.g., 'browser' catches all browser events)
    const sourceType = eventType.split(':')[0];
    if (sourceType && sourceType !== eventType) {
      const sourceHandlers = this.handlers.get(sourceType);
      if (sourceHandlers) {
        for (const handler of sourceHandlers) {
          try {
            handler(event);
          } catch (err) {
            this._onError(`Handler error for "${sourceType}"`, err);
          }
        }
      }
    }

    for (const handler of this.wildcardHandlers) {
      try {
        handler(event);
      } catch (err) {
        this._onError('Wildcard handler error', err);
      }
    }
  }

  /** Remove all subscribers */
  clear(): void {
    this.handlers.clear();
    this.wildcardHandlers.clear();
  }

  /** Total events emitted since creation */
  get emitCount(): number {
    return this._emitCount;
  }

  /** Number of registered handler entries */
  get handlerCount(): number {
    let count = this.wildcardHandlers.size;
    for (const set of this.handlers.values()) {
      count += set.size;
    }
    return count;
  }

  /**
   * Build the canonical event type string for a probe event.
   * Format: "{source}:{type}" e.g. "browser:click", "network:request"
   */
  static eventType(event: ProbeEvent): string {
    const type = (event as unknown as Record<string, unknown>)['type'];
    if (typeof type === 'string') {
      return `${event.source}:${type}`;
    }
    return event.source;
  }
}
