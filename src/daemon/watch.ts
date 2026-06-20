/**
 * Watch event model + in-memory event bus (RFC-0001 §4.2/§4.4). lanternd
 * publishes everything it does on an environment here; `lantern watch` clients
 * subscribe over the unix socket and render a read-only live transcript.
 *
 * Everything on the bus is ALREADY redacted (SessionManager redacts stdout/write
 * before emitting; secret VALUES are never published). The bus only buffers in
 * memory — the persisted record is audit.jsonl, a separate path.
 */

export type WatchEvent =
  | { ts: number; env: string; kind: "connect"; chain: string[] }
  | { ts: number; env: string; kind: "step"; text: string }
  | { ts: number; env: string; kind: "command"; method: string; command: string }
  | { ts: number; env: string; kind: "stdout"; text: string }
  | {
      ts: number;
      env: string;
      kind: "exit";
      method: string;
      exitCode: number | null;
      bytes: number;
      truncated?: boolean;
    }
  | { ts: number; env: string; kind: "denied"; method: string; command: string; reason: string }
  | { ts: number; env: string; kind: "error"; text: string }
  | { ts: number; env: string; kind: "meta"; text: string };

export type WatchSubscriber = (e: WatchEvent) => void;

export interface EventBusOptions {
  /** Ring-buffer capacity in events; replayed to each new subscriber. */
  bufferSize?: number;
}

/**
 * Synchronous fan-out bus with a bounded replay ring. Broadcast is single-tick
 * (no await between snapshot and subscribe, so no gap/dup); a throwing
 * subscriber can't break delivery to the others. Per-connection backpressure is
 * the subscriber's concern (handled by the watch socket writer, RFC §4.5).
 */
export class EventBus {
  private readonly ring: WatchEvent[] = [];
  private readonly cap: number;
  private readonly subs = new Set<WatchSubscriber>();

  constructor(opts: EventBusOptions = {}) {
    this.cap = Math.max(1, opts.bufferSize ?? 512);
  }

  publish(e: WatchEvent): void {
    this.ring.push(e);
    if (this.ring.length > this.cap) this.ring.shift();
    for (const fn of this.subs) {
      try {
        fn(e);
      } catch {
        // a misbehaving subscriber must not break the bus or the others
      }
    }
  }

  /**
   * Subscribe to live events. Unless `replay: false`, the new subscriber first
   * receives the current ring buffer (a snapshot, so re-publishing during replay
   * is safe), then live events. Returns an unsubscribe function.
   */
  subscribe(fn: WatchSubscriber, opts: { replay?: boolean } = {}): () => void {
    if (opts.replay !== false) {
      // snapshot: a subscriber that re-publishes during replay won't corrupt iteration
      for (const e of this.ring.slice()) {
        try {
          fn(e);
        } catch {
          // ignore — a replay failure shouldn't prevent live subscription
        }
      }
    }
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  }

  get subscriberCount(): number {
    return this.subs.size;
  }

  get buffered(): number {
    return this.ring.length;
  }
}
