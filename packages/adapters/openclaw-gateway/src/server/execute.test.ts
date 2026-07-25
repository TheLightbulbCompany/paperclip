import { describe, expect, it } from "vitest";
import {
  awaitRunResilient,
  buildAgentParams,
  classifyDailyBudgetCapDenial,
  isWaitPending,
  nextUtcMidnight,
  pickAssistantChunk,
  resolveClaimedApiKeyPath,
  resolveSessionKey,
} from "./execute.js";

describe("resolveSessionKey", () => {
  it("prefixes run-scoped session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "run",
        configuredSessionKey: null,
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip:run:run-123");
  });

  it("prefixes issue-scoped session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "issue",
        configuredSessionKey: null,
        agentId: "meridian",
        runId: "run-123",
        issueId: "issue-456",
      }),
    ).toBe("agent:meridian:paperclip:issue:issue-456");
  });

  it("prefixes fixed session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "paperclip",
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip");
  });

  it("does not double-prefix an already-routed session key", () => {
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "agent:meridian:paperclip",
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip");
  });
});

describe("buildAgentParams", () => {
  it("strips root-level paperclip fields from gateway agent params", () => {
    expect(
      buildAgentParams({
        payloadTemplate: {
          text: "old text",
          paperclip: { stale: true },
          keep: "value",
        },
        message: "wake text",
        sessionKey: "agent:meridian:paperclip:issue:issue-456",
        runId: "run-123",
        configuredAgentId: "meridian",
        waitTimeoutMs: 30_000,
      }),
    ).toEqual({
      keep: "value",
      message: "wake text",
      sessionKey: "agent:meridian:paperclip:issue:issue-456",
      idempotencyKey: "run-123",
      agentId: "meridian",
      timeout: 30_000,
    });
  });

  it("preserves an explicit agentId and timeout from the payload template", () => {
    expect(
      buildAgentParams({
        payloadTemplate: {
          agentId: "template-agent",
          timeout: 5_000,
        },
        message: "wake text",
        sessionKey: "paperclip",
        runId: "run-123",
        configuredAgentId: "configured-agent",
        waitTimeoutMs: 30_000,
      }),
    ).toEqual({
      agentId: "template-agent",
      timeout: 5_000,
      message: "wake text",
      sessionKey: "paperclip",
      idempotencyKey: "run-123",
    });
  });
});

describe("resolveClaimedApiKeyPath", () => {
  const DEFAULT_PATH = "~/.openclaw/workspace/paperclip-claimed-api-key.json";

  it("returns the configured per-agent path when set", () => {
    expect(
      resolveClaimedApiKeyPath("~/.openclaw/workspace/paperclip-keys/happy.json"),
    ).toBe("~/.openclaw/workspace/paperclip-keys/happy.json");
  });

  it("falls back to the shared default when value is empty", () => {
    expect(resolveClaimedApiKeyPath("")).toBe(DEFAULT_PATH);
    expect(resolveClaimedApiKeyPath("   ")).toBe(DEFAULT_PATH);
  });

  it("falls back to the shared default when value is missing", () => {
    expect(resolveClaimedApiKeyPath(undefined)).toBe(DEFAULT_PATH);
    expect(resolveClaimedApiKeyPath(null)).toBe(DEFAULT_PATH);
  });

  it("falls back to the shared default when value is not a string", () => {
    expect(resolveClaimedApiKeyPath(42)).toBe(DEFAULT_PATH);
    expect(resolveClaimedApiKeyPath({})).toBe(DEFAULT_PATH);
  });
});

describe("pickAssistantChunk (whitespace preservation)", () => {
  // Mirrors the adapter's assistant accumulator: push each streamed chunk,
  // then join and trim once. Regression guard for #1275 (agent-posted
  // Paperclip comments stored with all whitespace stripped).
  const summarize = (deltas: string[]): string =>
    deltas
      .map((delta) => pickAssistantChunk({ delta }))
      .filter((chunk): chunk is string => chunk !== null)
      .join("")
      .trim();

  it("keeps the leading space each LLM token carries (no per-chunk trim)", () => {
    expect(pickAssistantChunk({ delta: " work" })).toBe(" work");
    expect(pickAssistantChunk({ delta: "Planning" })).toBe("Planning");
  });

  it("preserves every inter-word space across a token-by-token stream", () => {
    // Fine-grained tokenization: every inter-word space rides as a LEADING
    // char on the next token — exactly the cadence that produced the
    // all-whitespace-stripped prod row.
    const tokens = [
      "Planning",
      "-",
      "only",
      " work",
      " completed",
      " locally",
      ".",
      " -",
      " Created",
      " plan",
      " artifact",
      ":",
      " plan",
      ".",
      "md",
    ];
    const intended = "Planning-only work completed locally. - Created plan artifact: plan.md";
    expect(tokens.join("")).toBe(intended);
    // Fixed behavior: spaces survive. (Old code trimmed each token then
    // join("")'d, storing "Planning-onlyworkcompletedlocally.-Createdplanartifact:plan.md".)
    expect(summarize(tokens)).toBe(intended);
    expect(/\s/.test(summarize(tokens))).toBe(true);
  });

  it("preserves spaces regardless of chunk cadence and bullets/newlines", () => {
    expect(summarize(["hello", " world", " foo", " bar"])).toBe("hello world foo bar");
    expect(summarize(["- item one", "\n", "- item two"])).toBe("- item one\n- item two");
  });

  it("falls back to data.text when no delta is present, without trimming", () => {
    expect(pickAssistantChunk({ text: " snapshot text " })).toBe(" snapshot text ");
    expect(pickAssistantChunk({ delta: "", text: " fallback" })).toBe(" fallback");
    expect(pickAssistantChunk({})).toBeNull();
  });
});

describe("isWaitPending", () => {
  it("treats a slice-expiry timeout (timeoutPhase, no endedAt) as pending", () => {
    expect(isWaitPending({ status: "timeout", timeoutPhase: "gateway_draining" })).toBe(true);
    expect(isWaitPending({ status: "timeout", timeoutPhase: "queue", providerStarted: false })).toBe(true);
  });

  it("treats a terminated run (ok/error, or timeout WITH endedAt) as not pending", () => {
    expect(isWaitPending({ status: "ok", endedAt: 10 })).toBe(false);
    expect(isWaitPending({ status: "error", endedAt: 10, error: "boom" })).toBe(false);
    expect(isWaitPending({ status: "timeout", endedAt: 10, stopReason: "timeout" })).toBe(false);
  });

  it("is not pending for empty or terminal-without-marker payloads", () => {
    expect(isWaitPending(null)).toBe(false);
    expect(isWaitPending(undefined)).toBe(false);
    expect(isWaitPending({ status: "ok" })).toBe(false);
  });
});

describe("awaitRunResilient", () => {
  const noopLog = async () => {};
  const noSleep = async () => {};
  const HOUR_MS = 60 * 60_000;

  it("calls agent.wait with the runId and the slice timeout", async () => {
    const calls: Array<{ method: string; params: unknown; opts: unknown }> = [];
    const client = {
      request: async <T>(method: string, params: unknown, opts: { timeoutMs: number }): Promise<T> => {
        calls.push({ method, params, opts });
        return { status: "ok", endedAt: 1 } as T;
      },
      close: () => {},
    };
    await awaitRunResilient({
      client,
      runId: "run-xyz",
      waitSliceMs: 5_000,
      maxRunMs: 1_000_000,
      stallTimeoutMs: 1_000_000,
      connectTimeoutMs: 10,
      connectClient: async () => client,
      onLog: noopLog,
      now: () => 0,
      sleep: noSleep,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("agent.wait");
    expect(calls[0].params).toEqual({ runId: "run-xyz", timeoutMs: 5_000 });
    expect(calls[0].opts).toEqual({ timeoutMs: 5_010 });
  });

  it("polls agent.wait through slice-expiry timeouts until the run terminates", async () => {
    const responses: Array<Record<string, unknown>> = [
      { status: "timeout", timeoutPhase: "gateway_draining" },
      { status: "timeout", timeoutPhase: "gateway_draining" },
      { status: "ok", endedAt: 1, result: { text: "done" } },
    ];
    let call = 0;
    const client = {
      request: async <T>(): Promise<T> => responses[call++] as T,
      close: () => {},
    };
    const result = await awaitRunResilient({
      client,
      runId: "run-1",
      waitSliceMs: 1_000,
      maxRunMs: 1_000_000,
      stallTimeoutMs: 1_000_000,
      connectTimeoutMs: 10,
      connectClient: async () => client,
      onLog: noopLog,
      now: () => 0,
      sleep: noSleep,
    });
    expect(result.status).toBe("ok");
    expect(call).toBe(3);
  });

  it("reconnects a fresh connection and resumes agent.wait after a drop", async () => {
    let reconnects = 0;
    let closedCount = 0;
    const makeClient = (failFirst: boolean) => {
      let asked = false;
      return {
        request: async <T>(): Promise<T> => {
          if (failFirst && !asked) {
            asked = true;
            throw new Error("gateway closed (1006): idle");
          }
          return { status: "ok", endedAt: 1 } as T;
        },
        close: () => {
          closedCount += 1;
        },
      };
    };
    const result = await awaitRunResilient({
      client: makeClient(true),
      runId: "run-1",
      waitSliceMs: 1_000,
      maxRunMs: 1_000_000,
      stallTimeoutMs: 1_000_000,
      connectTimeoutMs: 10,
      connectClient: async () => {
        reconnects += 1;
        return makeClient(false);
      },
      onLog: noopLog,
      now: () => 0,
      sleep: noSleep,
    });
    expect(result.status).toBe("ok");
    expect(reconnects).toBe(1);
    expect(closedCount).toBeGreaterThanOrEqual(1); // dropped connection was closed
  });

  it("retries a failed reconnect instead of abandoning a still-live run", async () => {
    let connectAttempts = 0;
    const droppedClient = {
      request: async <T>(): Promise<T> => {
        throw new Error("gateway closed (1006)");
      },
      close: () => {},
    };
    const okClient = {
      request: async <T>(): Promise<T> => ({ status: "ok", endedAt: 1 }) as T,
      close: () => {},
    };
    const result = await awaitRunResilient({
      client: droppedClient,
      runId: "run-1",
      waitSliceMs: 1_000,
      maxRunMs: 1_000_000,
      stallTimeoutMs: 1_000_000,
      connectTimeoutMs: 10,
      connectClient: async () => {
        connectAttempts += 1;
        if (connectAttempts < 3) throw new Error("gateway websocket open timeout");
        return okClient; // 3rd reconnect succeeds
      },
      onLog: noopLog,
      now: () => 0,
      sleep: noSleep,
    });
    expect(result.status).toBe("ok");
    // The reconnect itself failed twice and was retried, not escaped as a failure.
    expect(connectAttempts).toBe(3);
  });

  it("proactively reconnects before the 2h WS cap and resumes", async () => {
    let clock = 0;
    let reconnects = 0;
    const makeClient = () => ({
      request: async <T>(): Promise<T> => {
        clock += HOUR_MS; // each slice advances the injected clock by 1h
        return (reconnects >= 1
          ? { status: "ok", endedAt: clock }
          : { status: "timeout", timeoutPhase: "gateway_draining" }) as T;
      },
      close: () => {},
    });
    const result = await awaitRunResilient({
      client: makeClient(),
      runId: "run-1",
      waitSliceMs: 5 * 60_000,
      maxRunMs: 48 * HOUR_MS,
      stallTimeoutMs: 48 * HOUR_MS, // no stall
      connectTimeoutMs: 10,
      connectClient: async () => {
        reconnects += 1;
        return makeClient();
      },
      onLog: noopLog,
      now: () => clock,
      sleep: noSleep,
    });
    expect(result.status).toBe("ok");
    // Connection age crossed the ~110-min proactive-reconnect threshold before 2h.
    expect(reconnects).toBeGreaterThanOrEqual(1);
  });

  it("gives up with 'stalled' when a run shows no activity", async () => {
    let clock = 0;
    const client = {
      // A never-started / queued run: no endedAt, not gateway_draining.
      request: async <T>(): Promise<T> => {
        clock += 1_000;
        return { status: "timeout", timeoutPhase: "queue", providerStarted: false } as T;
      },
      close: () => {},
    };
    const result = await awaitRunResilient({
      client,
      runId: "run-1",
      waitSliceMs: 1_000,
      maxRunMs: 1_000_000,
      stallTimeoutMs: 5_000,
      connectTimeoutMs: 10,
      connectClient: async () => client,
      onLog: noopLog,
      now: () => clock,
      sleep: noSleep,
      getLastEventAt: () => 0,
    });
    expect(result.status).toBe("timeout");
    expect(result.timeoutPhase).toBe("stalled");
  });

  it("gives up with max_run_exceeded after actually looping through slices", async () => {
    let clock = 0;
    let sliceCalls = 0;
    const client = {
      request: async <T>(): Promise<T> => {
        sliceCalls += 1;
        clock += 100; // each slice advances 100ms; run keeps signalling active
        return { status: "timeout", timeoutPhase: "gateway_draining" } as T;
      },
      close: () => {},
    };
    const result = await awaitRunResilient({
      client,
      runId: "run-1",
      waitSliceMs: 100,
      maxRunMs: 300,
      stallTimeoutMs: 1_000_000,
      connectTimeoutMs: 10,
      connectClient: async () => client,
      onLog: noopLog,
      now: () => clock,
      sleep: noSleep,
    });
    expect(result.status).toBe("timeout");
    expect(result.timeoutPhase).toBe("max_run_exceeded");
    expect(sliceCalls).toBeGreaterThanOrEqual(2); // exercised the slice loop, not a first-iteration exit
  });
});

describe("nextUtcMidnight", () => {
  it("returns the next UTC midnight, rolling over month boundaries", () => {
    expect(nextUtcMidnight(new Date("2026-07-24T18:31:07.000Z")).toISOString())
      .toBe("2026-07-25T00:00:00.000Z");
    expect(nextUtcMidnight(new Date("2026-07-31T23:59:59.999Z")).toISOString())
      .toBe("2026-08-01T00:00:00.000Z");
    // Exactly midnight parks at the NEXT midnight — the cap covers the day just started.
    expect(nextUtcMidnight(new Date("2026-07-25T00:00:00.000Z")).toISOString())
      .toBe("2026-07-26T00:00:00.000Z");
  });
});

describe("classifyDailyBudgetCapDenial", () => {
  const now = new Date("2026-07-24T18:31:07.000Z");

  it("classifies the daily-cap denial as provider_quota parked just past the next UTC midnight", () => {
    const result = classifyDailyBudgetCapDenial(
      "FailoverError: isol8: daily free limit reached — resets at midnight UTC",
      now,
      () => 0,
    );
    expect(result).toEqual({
      errorCode: "provider_quota",
      errorFamily: "provider_quota",
      retryNotBefore: "2026-07-25T00:01:00.000Z",
    });
  });

  it("jitters the park time between one and five minutes past midnight", () => {
    const atMax = classifyDailyBudgetCapDenial("daily free limit reached", now, () => 1);
    expect(atMax?.retryNotBefore).toBe("2026-07-25T00:05:00.000Z");

    const midway = classifyDailyBudgetCapDenial("daily free limit reached", now, () => 0.5);
    expect(midway?.retryNotBefore).toBe("2026-07-25T00:03:00.000Z");
  });

  it("matches the denial snippet case-insensitively", () => {
    expect(classifyDailyBudgetCapDenial("Daily Free Limit Reached — try tomorrow", now, () => 0))
      .not.toBeNull();
  });

  it("leaves ordinary gateway errors unclassified so they keep their normal retry behavior", () => {
    expect(classifyDailyBudgetCapDenial("OpenClaw gateway run failed", now)).toBeNull();
    expect(classifyDailyBudgetCapDenial("429 rate limited, please slow down", now)).toBeNull();
    expect(classifyDailyBudgetCapDenial("", now)).toBeNull();
    expect(classifyDailyBudgetCapDenial(null, now)).toBeNull();
    expect(classifyDailyBudgetCapDenial(undefined, now)).toBeNull();
  });
});
