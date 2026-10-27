/**
 * isol8: idle back-off for the in-process pollers.
 *
 * The pollers ran on fixed intervals (1 s to 30 s) whether or not there was
 * work, so the database pool never went idle and Aurora Serverless v2 could
 * never auto-pause. A poller started here keeps its base interval while the
 * server sees activity: any HTTP request except /api/health, or any live
 * event. After IDLE_BACKOFF_AFTER_TICKS ticks with no activity, its delay
 * doubles on each tick, up to IDLE_BACKOFF_MAX_MS. The next activity wakes a
 * backed-off poller at once and restores its base interval, so behaviour
 * under load is unchanged.
 *
 * Pollers at the cap tick on shared wall-clock boundaries (multiples of the
 * cap), so an idle server queries in one burst per cap and the pool sees no
 * connection in between. The cap must exceed Aurora's 300 s auto-pause delay
 * plus the pool idle timeout: unaligned 5 min pollers would never leave a
 * 300 s gap. PAPERCLIP_IDLE_BACKOFF_MAX_MS overrides it.
 *
 * Time-based work that only a poll discovers (timer heartbeats, routine
 * schedules) can start up to IDLE_BACKOFF_MAX_MS late on an idle server.
 */
export const IDLE_BACKOFF_MAX_MS =
  Number(process.env.PAPERCLIP_IDLE_BACKOFF_MAX_MS) || 15 * 60_000;
export const IDLE_BACKOFF_AFTER_TICKS = 3;

let lastActivityAt = Date.now();
const wakers = new Set<() => void>();

export function noteServerActivity(at = Date.now()): void {
  lastActivityAt = at;
  for (const wake of wakers) wake();
}

/** True when the server has seen no activity for `quietMs`. */
export function isServerIdle(quietMs = 60_000, now = Date.now()): boolean {
  return now - lastActivityAt >= quietMs;
}

export interface IdleBackoffInterval {
  stop(): void;
  /** The delay before the next tick (for tests and logs). */
  currentDelayMs(): number;
}

/**
 * A drop-in for setInterval(tick, baseMs) that backs off while the server is
 * idle. `tick` is called synchronously, as setInterval would; start async work
 * from it and let it settle on its own.
 */
export function startIdleBackoffInterval(
  tick: () => void,
  baseMs: number,
  options: { maxMs?: number; idleTicks?: number } = {},
): IdleBackoffInterval {
  const maxMs = Math.max(baseMs, options.maxMs ?? IDLE_BACKOFF_MAX_MS);
  const idleTicks = options.idleTicks ?? IDLE_BACKOFF_AFTER_TICKS;
  let quietTicks = 0;
  let seen = lastActivityAt;
  let delay = baseMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const schedule = (ms: number) => {
    timer = setTimeout(run, ms);
    timer.unref?.();
  };
  function run() {
    timer = null;
    if (stopped) return;
    if (lastActivityAt !== seen) {
      seen = lastActivityAt;
      quietTicks = 0;
    } else {
      quietTicks += 1;
    }
    delay = quietTicks < idleTicks
      ? baseMs
      : Math.min(maxMs, baseMs * 2 ** (quietTicks - idleTicks + 1));
    try {
      tick();
    } finally {
      if (!stopped) {
        schedule(delay > baseMs && delay === maxMs ? delay - (Date.now() % delay) : delay);
      }
    }
  }
  const wake = () => {
    // Only a backed-off poller is pulled forward; one at its base interval
    // keeps its cadence, exactly as setInterval would.
    if (stopped || delay === baseMs || !timer) return;
    clearTimeout(timer);
    delay = baseMs;
    schedule(0);
  };

  wakers.add(wake);
  schedule(baseMs);
  return {
    stop() {
      stopped = true;
      wakers.delete(wake);
      if (timer) clearTimeout(timer);
      timer = null;
    },
    currentDelayMs: () => delay,
  };
}
