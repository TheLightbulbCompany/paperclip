import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  projects,
  routineRevisions,
  routineRuns,
  routineTriggers,
  routines,
} from "@paperclipai/db";
import type { IssueExecutionPolicy } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { routineService } from "../services/routines.ts";
import { applyIssueExecutionPolicyTransition } from "../services/issue-execution-policy.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routine execution-policy tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("routine execution policy", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-exec-policy-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(routineRevisions);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name = "Paperclip") {
    const companyId = randomUUID();
    const workerAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const projectId = randomUUID();
    const defaultResponsibleUserId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: workerAgentId,
        companyId,
        name: "Worker",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: reviewerAgentId,
        companyId,
        name: "Reviewer",
        role: "reviewer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Routines",
      status: "in_progress",
    });

    return { companyId, workerAgentId, reviewerAgentId, projectId, defaultResponsibleUserId };
  }

  function makeService() {
    const wakeups: Array<{ agentId: string; opts: Record<string, unknown> }> = [];
    const svc = routineService(db, {
      heartbeat: {
        wakeup: async (agentId: string, opts: Record<string, unknown>) => {
          wakeups.push({ agentId, opts });
          return null;
        },
      },
    });
    return { svc, wakeups };
  }

  function reviewPolicy(reviewerAgentId: string) {
    return {
      stages: [{ type: "review" as const, participants: [{ type: "agent" as const, agentId: reviewerAgentId }] }],
    };
  }

  async function createRoutine(
    svc: ReturnType<typeof makeService>["svc"],
    companyId: string,
    projectId: string,
    assigneeAgentId: string,
    executionPolicy?: unknown,
  ) {
    return svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "nightly sweep",
        description: "Sweep the thing",
        assigneeAgentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        ...(executionPolicy === undefined ? {} : { executionPolicy }),
      } as Parameters<typeof svc.create>[1],
      {},
    );
  }

  async function issueForRun(runId: string) {
    const run = await db
      .select({ linkedIssueId: routineRuns.linkedIssueId })
      .from(routineRuns)
      .where(eq(routineRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (!run?.linkedIssueId) return null;
    return db
      .select()
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId))
      .then((rows) => rows[0] ?? null);
  }

  describe("persistence + revisions", () => {
    it("round-trips the policy through create, update, and revision restore", async () => {
      const { companyId, workerAgentId, reviewerAgentId, projectId } = await seedCompany();
      const { svc } = makeService();

      const routine = await createRoutine(svc, companyId, projectId, workerAgentId, reviewPolicy(reviewerAgentId));

      const stored = routine.executionPolicy as IssueExecutionPolicy;
      expect(stored.stages).toHaveLength(1);
      expect(stored.stages[0]!.type).toBe("review");
      expect(stored.stages[0]!.participants[0]).toMatchObject({ type: "agent", agentId: reviewerAgentId });
      // normalizeIssueExecutionPolicy stamps the canonical defaults, exactly as
      // it does for a hand-created issue.
      expect(stored.mode).toBe("normal");
      expect(stored.commentRequired).toBe(true);
      expect(stored.stages[0]!.approvalsNeeded).toBe(1);

      const revision1 = await svc.listRevisions(routine.id).then((rows) => rows[0]!);
      expect(revision1.snapshot.routine.executionPolicy).toEqual(stored);

      // Update: swap the reviewer to the worker's own agent.
      const updated = await svc.update(
        routine.id,
        { executionPolicy: reviewPolicy(workerAgentId) } as Parameters<typeof svc.update>[1],
        {},
      );
      expect((updated!.executionPolicy as IssueExecutionPolicy).stages[0]!.participants[0]!.agentId).toBe(workerAgentId);
      expect(updated!.latestRevisionNumber).toBe(2);

      // Clearing it is expressible and persists as null.
      const cleared = await svc.update(routine.id, { executionPolicy: null } as Parameters<typeof svc.update>[1], {});
      expect(cleared!.executionPolicy).toBeNull();
      expect(cleared!.latestRevisionNumber).toBe(3);

      // Restoring revision 1 brings the original reviewer back.
      const restored = await svc.restoreRevision(routine.id, revision1.id, {});
      expect((restored.routine.executionPolicy as IssueExecutionPolicy).stages[0]!.participants[0]!.agentId).toBe(
        reviewerAgentId,
      );
      expect(restored.revision.snapshot.routine.executionPolicy).toEqual(stored);
    });

    it("omits executionPolicy from the snapshot when the routine has none", async () => {
      const { companyId, workerAgentId, projectId } = await seedCompany();
      const { svc } = makeService();

      const routine = await createRoutine(svc, companyId, projectId, workerAgentId);
      expect(routine.executionPolicy).toBeNull();

      const revision = await svc.listRevisions(routine.id).then((rows) => rows[0]!);
      // Not `executionPolicy: null` — the key must be absent, or every snapshot
      // written before this field existed would compare as changed and a
      // no-op edit would mint a spurious revision.
      expect(Object.keys(revision.snapshot.routine)).not.toContain("executionPolicy");

      // A no-op update still short-circuits to the same revision.
      const updated = await svc.update(routine.id, { title: routine.title } as Parameters<typeof svc.update>[1], {});
      expect(updated!.latestRevisionNumber).toBe(1);
      expect(updated!.latestRevisionId).toBe(routine.latestRevisionId);
    });
  });

  describe("authorization", () => {
    it("rejects a reviewer agent from another company on create", async () => {
      const { companyId, workerAgentId, projectId } = await seedCompany();
      const other = await seedCompany("Other Co");
      const { svc } = makeService();

      await expect(
        createRoutine(svc, companyId, projectId, workerAgentId, reviewPolicy(other.reviewerAgentId)),
      ).rejects.toMatchObject({ status: 422 });
    });

    it("rejects an unknown reviewer agent on create", async () => {
      const { companyId, workerAgentId, projectId } = await seedCompany();
      const { svc } = makeService();

      await expect(
        createRoutine(svc, companyId, projectId, workerAgentId, reviewPolicy(randomUUID())),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("rejects a cross-company reviewer on update", async () => {
      const { companyId, workerAgentId, reviewerAgentId, projectId } = await seedCompany();
      const other = await seedCompany("Other Co");
      const { svc } = makeService();

      const routine = await createRoutine(svc, companyId, projectId, workerAgentId, reviewPolicy(reviewerAgentId));

      await expect(
        svc.update(
          routine.id,
          { executionPolicy: reviewPolicy(other.reviewerAgentId) } as Parameters<typeof svc.update>[1],
          {},
        ),
      ).rejects.toMatchObject({ status: 422 });

      const unchanged = await svc.get(routine.id);
      expect((unchanged!.executionPolicy as IssueExecutionPolicy).stages[0]!.participants[0]!.agentId).toBe(
        reviewerAgentId,
      );
    });

    it("rejects a malformed policy", async () => {
      const { companyId, workerAgentId, projectId } = await seedCompany();
      const { svc } = makeService();

      await expect(
        createRoutine(svc, companyId, projectId, workerAgentId, {
          stages: [{ type: "review", participants: [{ type: "agent" }] }],
        }),
      ).rejects.toMatchObject({ status: 422 });
    });
  });

  describe("dispatch", () => {
    it("stamps the policy onto the generated run issue", async () => {
      const { companyId, workerAgentId, reviewerAgentId, projectId } = await seedCompany();
      const { svc } = makeService();

      const routine = await createRoutine(svc, companyId, projectId, workerAgentId, reviewPolicy(reviewerAgentId));
      const run = await svc.runRoutine(routine.id, { source: "manual" }, {});
      const issue = await issueForRun(run.id);

      expect(issue).not.toBeNull();
      expect(issue!.assigneeAgentId).toBe(workerAgentId);
      expect(issue!.status).toBe("todo");
      expect(issue!.executionPolicy).toEqual(routine.executionPolicy);
    });

    it("leaves the generated issue's policy null when the routine has none", async () => {
      const { companyId, workerAgentId, projectId } = await seedCompany();
      const { svc } = makeService();

      const routine = await createRoutine(svc, companyId, projectId, workerAgentId);
      const run = await svc.runRoutine(routine.id, { source: "manual" }, {});
      const issue = await issueForRun(run.id);

      expect(issue).not.toBeNull();
      expect(issue!.executionPolicy).toBeNull();
      expect(issue!.executionState).toBeNull();
      expect(issue!.status).toBe("todo");
      expect(issue!.assigneeAgentId).toBe(workerAgentId);
    });
  });

  describe("review lifecycle on a routine-generated issue", () => {
    /**
     * Drives the REAL generated issue row through the REAL transition the
     * issues PATCH route calls. Nothing here is routine-aware: the lifecycle
     * reads only the issue's stored executionPolicy/executionState, which is
     * the whole point — a routine issue is an ordinary reviewed issue.
     */
    async function generatedIssue() {
      const seed = await seedCompany();
      const { svc } = makeService();
      const routine = await createRoutine(
        svc,
        seed.companyId,
        seed.projectId,
        seed.workerAgentId,
        reviewPolicy(seed.reviewerAgentId),
      );
      const run = await svc.runRoutine(routine.id, { source: "manual" }, {});
      const issue = await issueForRun(run.id);
      return { ...seed, routine, issue: issue! };
    }

    it("parks the issue on the reviewer when the worker finishes", async () => {
      const { issue, workerAgentId, reviewerAgentId } = await generatedIssue();

      const transition = applyIssueExecutionPolicyTransition({
        issue: { ...issue, status: "in_progress", assigneeAgentId: workerAgentId },
        policy: issue.executionPolicy as IssueExecutionPolicy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: workerAgentId },
      });

      // in_review + reassigned to the reviewer is exactly what the route's
      // wake builder keys off to send `execution_review_requested`.
      expect(transition.patch.status).toBe("in_review");
      expect(transition.patch.assigneeAgentId).toBe(reviewerAgentId);
      expect(transition.workflowControlledAssignment).toBe(true);
      const state = transition.patch.executionState as Record<string, unknown>;
      expect(state.status).toBe("pending");
      expect(state.currentParticipant).toMatchObject({ type: "agent", agentId: reviewerAgentId });
      expect(state.returnAssignee).toMatchObject({ type: "agent", agentId: workerAgentId });
    });

    it("completes the issue when the reviewer approves", async () => {
      const { issue, workerAgentId, reviewerAgentId } = await generatedIssue();
      const policy = issue.executionPolicy as IssueExecutionPolicy;

      const pending = applyIssueExecutionPolicyTransition({
        issue: { ...issue, status: "in_progress", assigneeAgentId: workerAgentId },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: workerAgentId },
      });

      const approval = applyIssueExecutionPolicyTransition({
        issue: {
          ...issue,
          status: "in_review",
          assigneeAgentId: reviewerAgentId,
          executionState: pending.patch.executionState as Record<string, unknown>,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: reviewerAgentId },
        commentBody: "Checked the output, ships.",
      });

      // No status override on the last stage: the reviewer's own `done` stands.
      expect(approval.patch.status).toBeUndefined();
      expect((approval.patch.executionState as Record<string, unknown>).status).toBe("completed");
      expect(approval.decision).toMatchObject({ stageType: "review", outcome: "approved" });
    });

    it("returns the issue to the worker when the reviewer requests changes", async () => {
      const { issue, workerAgentId, reviewerAgentId } = await generatedIssue();
      const policy = issue.executionPolicy as IssueExecutionPolicy;

      const pending = applyIssueExecutionPolicyTransition({
        issue: { ...issue, status: "in_progress", assigneeAgentId: workerAgentId },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: workerAgentId },
      });

      const changes = applyIssueExecutionPolicyTransition({
        issue: {
          ...issue,
          status: "in_review",
          assigneeAgentId: reviewerAgentId,
          executionState: pending.patch.executionState as Record<string, unknown>,
        },
        policy,
        requestedStatus: "in_progress",
        requestedAssigneePatch: {},
        actor: { agentId: reviewerAgentId },
        commentBody: "Missing the summary section.",
      });

      expect(changes.patch.status).toBe("in_progress");
      expect(changes.patch.assigneeAgentId).toBe(workerAgentId);
      expect((changes.patch.executionState as Record<string, unknown>).status).toBe("changes_requested");
      expect(changes.decision).toMatchObject({ stageType: "review", outcome: "changes_requested" });
    });
  });
});
