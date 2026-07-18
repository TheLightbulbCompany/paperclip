import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issues,
  routineRuns,
  routineTriggers,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { applyRoutineOutcome } from "../services/routine-circuit-breaker.js";
import { issueService } from "../services/issues.js";
import { routineService } from "../services/routines.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routine circuit-breaker tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("routine circuit breaker", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let routinesSvc!: ReturnType<typeof routineService>;
  let issuesSvc!: ReturnType<typeof issueService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-circuit-breaker-");
    db = createDb(tempDb.connectionString);
    routinesSvc = routineService(db, { heartbeat: { wakeup: vi.fn(async () => ({ id: randomUUID() })) } });
    issuesSvc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(issues);
    await db.delete(activityLog);
    await db.delete(routines);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRoutine(opts: {
    consecutiveFailureCount?: number;
    autoPauseThreshold?: number | null;
    autoPauseEnabled?: boolean | null;
    status?: "active" | "paused";
    autoPausedAt?: Date | null;
  } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: issuePrefix(companyId) });
    const [agent] = await db.insert(agents).values({
      companyId,
      name: "Friday",
      role: "ceo",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    const [routine] = await db.insert(routines).values({
      companyId,
      title: "Market Intelligence Sweep -> Email",
      assigneeAgentId: agent.id,
      status: opts.status ?? "active",
      consecutiveFailureCount: opts.consecutiveFailureCount ?? 0,
      autoPauseThreshold: opts.autoPauseThreshold ?? 3,
      autoPauseEnabled: opts.autoPauseEnabled ?? null,
      autoPausedAt: opts.autoPausedAt ?? null,
      autoPauseReason: opts.autoPausedAt ? "consecutive_failures" : null,
    }).returning();
    return { companyId, agentId: agent.id, routine };
  }

  // Seed a routine run + its execution issue (the issue an agent works on).
  async function seedRoutineIssue(companyId: string, routineId: string, assigneeAgentId: string) {
    const runId = randomUUID();
    await db.insert(routineRuns).values({
      id: runId,
      companyId,
      routineId,
      source: "schedule",
      status: "issue_created",
    });
    const [issue] = await db.insert(issues).values({
      companyId,
      title: "sweep run",
      status: "todo",
      assigneeAgentId,
      originKind: "routine_execution",
      originRunId: runId,
    }).returning();
    return { runId, issueId: issue.id };
  }

  async function getRoutine(id: string) {
    const [r] = await db.select().from(routines).where(eq(routines.id, id));
    return r;
  }

  // ---- Counter logic (applyRoutineOutcome directly) ----

  it("resets consecutiveFailureCount to 0 on a completed outcome", async () => {
    const { companyId, routine } = await seedRoutine({ consecutiveFailureCount: 2 });
    await applyRoutineOutcome(db, routine.id, companyId, "completed");
    const r = await getRoutine(routine.id);
    expect(r.consecutiveFailureCount).toBe(0);
    expect(r.status).toBe("active");
  });

  it("increments on a failed outcome but does not pause below threshold", async () => {
    const { companyId, routine } = await seedRoutine({ consecutiveFailureCount: 1, autoPauseThreshold: 3 });
    await applyRoutineOutcome(db, routine.id, companyId, "failed");
    const r = await getRoutine(routine.id);
    expect(r.consecutiveFailureCount).toBe(2);
    expect(r.status).toBe("active");
  });

  it("pauses the routine when the failure count reaches the threshold", async () => {
    const { companyId, routine } = await seedRoutine({ consecutiveFailureCount: 2, autoPauseThreshold: 3 });
    await applyRoutineOutcome(db, routine.id, companyId, "failed");
    const r = await getRoutine(routine.id);
    expect(r.consecutiveFailureCount).toBe(3);
    expect(r.status).toBe("paused");
    expect(r.autoPauseReason).toBe("consecutive_failures");
    expect(r.autoPausedAt).not.toBeNull();
    const events = await db.select().from(activityLog).where(eq(activityLog.entityId, routine.id));
    expect(events.some((e) => e.action === "routine.auto_paused")).toBe(true);
  });

  it("honors a per-routine autoPauseEnabled=false override (never pauses)", async () => {
    const { companyId, routine } = await seedRoutine({ consecutiveFailureCount: 2, autoPauseThreshold: 3, autoPauseEnabled: false });
    await applyRoutineOutcome(db, routine.id, companyId, "failed");
    const r = await getRoutine(routine.id);
    expect(r.consecutiveFailureCount).toBe(3);
    expect(r.status).toBe("active");
  });

  it("uses the instance-settings default threshold (3) when the routine has no override", async () => {
    const { companyId, routine } = await seedRoutine({ consecutiveFailureCount: 2, autoPauseThreshold: null });
    await applyRoutineOutcome(db, routine.id, companyId, "failed");
    const r = await getRoutine(routine.id);
    expect(r.status).toBe("paused");
  });

  // ---- The real hook: issuesSvc.update terminal transitions (the recovery path that was missed) ----

  it("increments the routine counter when a routine-execution issue is set to blocked via issuesSvc.update", async () => {
    const { companyId, agentId, routine } = await seedRoutine({ consecutiveFailureCount: 0, autoPauseThreshold: 3 });
    const { issueId } = await seedRoutineIssue(companyId, routine.id, agentId);
    await issuesSvc.update(issueId, { status: "blocked" });
    const r = await getRoutine(routine.id);
    expect(r.consecutiveFailureCount).toBe(1);
    expect(r.status).toBe("active");
  });

  it("auto-pauses when 3 routine-execution issues are blocked via issuesSvc.update (recovery-path scenario)", async () => {
    const { companyId, agentId, routine } = await seedRoutine({ consecutiveFailureCount: 0, autoPauseThreshold: 3 });
    for (let i = 0; i < 3; i += 1) {
      const { issueId } = await seedRoutineIssue(companyId, routine.id, agentId);
      await issuesSvc.update(issueId, { status: "blocked" });
    }
    const r = await getRoutine(routine.id);
    expect(r.consecutiveFailureCount).toBe(3);
    expect(r.status).toBe("paused");
    expect(r.autoPauseReason).toBe("consecutive_failures");
  });

  it("resets the counter when a routine-execution issue is set to done via issuesSvc.update", async () => {
    const { companyId, agentId, routine } = await seedRoutine({ consecutiveFailureCount: 2, autoPauseThreshold: 3 });
    const { issueId } = await seedRoutineIssue(companyId, routine.id, agentId);
    await issuesSvc.update(issueId, { status: "done" });
    const r = await getRoutine(routine.id);
    expect(r.consecutiveFailureCount).toBe(0);
    expect(r.status).toBe("active");
  });

  it("does not touch the routine when a non-routine issue is updated", async () => {
    const { companyId, agentId, routine } = await seedRoutine({ consecutiveFailureCount: 1, autoPauseThreshold: 3 });
    const [issue] = await db.insert(issues).values({
      companyId,
      title: "plain issue",
      status: "todo",
      assigneeAgentId: agentId,
    }).returning();
    await issuesSvc.update(issue.id, { status: "blocked" });
    const r = await getRoutine(routine.id);
    expect(r.consecutiveFailureCount).toBe(1);
  });

  // ---- Resume + scheduler enforcement ----

  it("resets failure state when a paused routine is re-enabled", async () => {
    const { routine } = await seedRoutine({ status: "paused", consecutiveFailureCount: 3, autoPausedAt: new Date() });
    await routinesSvc.update(routine.id, { status: "active" }, { userId: "u_test" });
    const r = await getRoutine(routine.id);
    expect(r.status).toBe("active");
    expect(r.consecutiveFailureCount).toBe(0);
    expect(r.autoPausedAt).toBeNull();
    expect(r.autoPauseReason).toBeNull();
  });

  it("does not fire a paused routine from tickScheduledTriggers", async () => {
    const { companyId, routine } = await seedRoutine({ status: "paused", consecutiveFailureCount: 3, autoPausedAt: new Date() });
    await db.insert(routineTriggers).values({
      companyId,
      routineId: routine.id,
      kind: "schedule",
      cronExpression: "0 * * * *",
      timezone: "UTC",
      nextRunAt: new Date(Date.now() - 60_000),
    });
    const { triggered } = await routinesSvc.tickScheduledTriggers(new Date());
    const runs = await db.select().from(routineRuns).where(eq(routineRuns.routineId, routine.id));
    expect(triggered).toBe(0);
    expect(runs.length).toBe(0);
  });
});
