import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IDLE_BACKOFF_MAX_MS,
  isServerIdle,
  noteServerActivity,
  startIdleBackoffInterval,
} from "../services/idle-backoff.js";

describe("startIdleBackoffInterval", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    noteServerActivity();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the base interval while the server sees activity", () => {
    const tick = vi.fn();
    const loop = startIdleBackoffInterval(tick, 1_000);
    for (let i = 0; i < 20; i++) {
      noteServerActivity();
      vi.advanceTimersByTime(1_000);
    }
    expect(tick).toHaveBeenCalledTimes(20);
    expect(loop.currentDelayMs()).toBe(1_000);
    loop.stop();
  });

  it("backs off exponentially to the cap when idle", () => {
    const tick = vi.fn();
    const loop = startIdleBackoffInterval(tick, 1_000);
    const delays: number[] = [];
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(loop.currentDelayMs());
      delays.push(loop.currentDelayMs());
    }
    // The third quiet tick starts the back-off.
    expect(delays.slice(0, 6)).toEqual([1_000, 1_000, 2_000, 4_000, 8_000, 16_000]);
    expect(delays.at(-1)).toBe(IDLE_BACKOFF_MAX_MS);
    // At the cap, one tick per cap.
    tick.mockClear();
    vi.advanceTimersByTime(IDLE_BACKOFF_MAX_MS * 4);
    expect(tick.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(tick.mock.calls.length).toBeLessThanOrEqual(5);
    loop.stop();
  });

  it("aligns pollers at the cap to the same wall-clock boundaries", () => {
    const fired: Array<[string, number]> = [];
    const a = startIdleBackoffInterval(() => fired.push(["a", Date.now()]), 1_000);
    vi.advanceTimersByTime(7_777);
    const b = startIdleBackoffInterval(() => fired.push(["b", Date.now()]), 30_000);
    vi.advanceTimersByTime(IDLE_BACKOFF_MAX_MS * 6);
    fired.length = 0;
    vi.advanceTimersByTime(IDLE_BACKOFF_MAX_MS * 2);
    expect(fired).toHaveLength(4);
    for (const [, at] of fired) expect(at % IDLE_BACKOFF_MAX_MS).toBe(0);
    a.stop();
    b.stop();
  });

  it("wakes a backed-off loop at once on activity and restores the base interval", () => {
    const tick = vi.fn();
    const loop = startIdleBackoffInterval(tick, 1_000);
    vi.advanceTimersByTime(30 * 60_000);
    expect(loop.currentDelayMs()).toBe(IDLE_BACKOFF_MAX_MS);
    tick.mockClear();
    noteServerActivity();
    vi.advanceTimersByTime(0);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(loop.currentDelayMs()).toBe(1_000);
    vi.advanceTimersByTime(1_000);
    expect(tick).toHaveBeenCalledTimes(2);
    loop.stop();
  });

  it("does not pull a loop at its base interval forward", () => {
    const tick = vi.fn();
    const loop = startIdleBackoffInterval(tick, 1_000);
    vi.advanceTimersByTime(500);
    noteServerActivity();
    vi.advanceTimersByTime(0);
    expect(tick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(tick).toHaveBeenCalledTimes(1);
    loop.stop();
  });

  it("never runs after stop", () => {
    const tick = vi.fn();
    const loop = startIdleBackoffInterval(tick, 1_000);
    loop.stop();
    noteServerActivity();
    vi.advanceTimersByTime(60_000);
    expect(tick).not.toHaveBeenCalled();
  });

  it("keeps a loop slower than the cap at its own interval", () => {
    const tick = vi.fn();
    const loop = startIdleBackoffInterval(tick, 60 * 60_000);
    vi.advanceTimersByTime(10 * 60 * 60_000);
    expect(tick).toHaveBeenCalledTimes(10);
    loop.stop();
  });
});

describe("isServerIdle", () => {
  it("reports idle only after the quiet window", () => {
    noteServerActivity(1_000);
    expect(isServerIdle(60_000, 30_000)).toBe(false);
    expect(isServerIdle(60_000, 61_000)).toBe(true);
  });
});
