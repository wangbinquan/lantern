import { describe, expect, test } from "bun:test";
import { EventBus, type WatchEvent } from "../src/daemon";

function ev(env: string, text: string): WatchEvent {
  return { ts: 0, env, kind: "meta", text };
}

/** Collect the `text` of meta events delivered to a subscriber. */
function collector(into: string[]): (e: WatchEvent) => void {
  return (e) => {
    if (e.kind === "meta") into.push(e.text);
  };
}

describe("EventBus (RFC-0001)", () => {
  test("replays the ring buffer to a new subscriber, then delivers live", () => {
    const bus = new EventBus();
    bus.publish(ev("a", "1"));
    bus.publish(ev("a", "2"));
    const got: string[] = [];
    bus.subscribe(collector(got));
    expect(got).toEqual(["1", "2"]); // replay
    bus.publish(ev("a", "3"));
    expect(got).toEqual(["1", "2", "3"]); // live
  });

  test("replay: false skips the backlog", () => {
    const bus = new EventBus();
    bus.publish(ev("a", "old"));
    const got: string[] = [];
    bus.subscribe(collector(got), { replay: false });
    expect(got).toEqual([]);
    bus.publish(ev("a", "new"));
    expect(got).toEqual(["new"]);
  });

  test("ring buffer caps at bufferSize, dropping oldest", () => {
    const bus = new EventBus({ bufferSize: 2 });
    bus.publish(ev("a", "1"));
    bus.publish(ev("a", "2"));
    bus.publish(ev("a", "3"));
    expect(bus.buffered).toBe(2);
    const got: string[] = [];
    bus.subscribe(collector(got));
    expect(got).toEqual(["2", "3"]);
  });

  test("broadcasts to multiple subscribers", () => {
    const bus = new EventBus();
    const a: string[] = [];
    const b: string[] = [];
    bus.subscribe(collector(a));
    bus.subscribe(collector(b));
    bus.publish(ev("x", "hi"));
    expect(a).toEqual(["hi"]);
    expect(b).toEqual(["hi"]);
    expect(bus.subscriberCount).toBe(2);
  });

  test("unsubscribe stops delivery", () => {
    const bus = new EventBus();
    const got: string[] = [];
    const off = bus.subscribe(collector(got));
    bus.publish(ev("a", "1"));
    off();
    bus.publish(ev("a", "2"));
    expect(got).toEqual(["1"]);
    expect(bus.subscriberCount).toBe(0);
  });

  test("a throwing subscriber does not break the others", () => {
    const bus = new EventBus();
    const got: string[] = [];
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe(collector(got));
    expect(() => bus.publish(ev("a", "ok"))).not.toThrow();
    expect(got).toEqual(["ok"]);
  });
});
