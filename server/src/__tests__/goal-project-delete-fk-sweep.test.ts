import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  costEvents,
  createDb,
  financeEvents,
  goals,
  issues,
  projectGoals,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { goalService } from "../services/goals.js";
import { projectService } from "../services/projects.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// DELETE /api/goals/:id and /api/projects/:id returned a 502 (SQLSTATE 23503)
// whenever a task, project, sub-goal or cost/finance row still pointed at the
// row: those FKs have no delete policy. remove() now detaches them first.
describeEmbeddedPostgres("goal/project remove FK sweep", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-goal-project-fk-sweep-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(financeEvents);
    await db.delete(costEvents);
    await db.delete(issues);
    await db.delete(projectGoals);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const rootGoalId = randomUUID();
    const goalId = randomUUID();
    const subGoalId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const costEventId = randomUUID();
    const financeEventId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Origin",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(goals).values([
      { id: rootGoalId, companyId, title: "Root", level: "company", status: "active" },
      { id: goalId, companyId, parentId: rootGoalId, title: "Doomed", level: "team", status: "active" },
      { id: subGoalId, companyId, parentId: goalId, title: "Child", level: "task", status: "active" },
    ]);
    await db.insert(projects).values({ id: projectId, companyId, goalId, name: "Doomed project" });
    await db.insert(projectGoals).values({ projectId, goalId, companyId });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      projectId,
      title: "Hidden linked task",
      status: "cancelled",
      priority: "medium",
    });
    await db.insert(costEvents).values({
      id: costEventId,
      companyId,
      agentId,
      projectId,
      goalId,
      provider: "openrouter",
      model: "m",
      costCents: 5,
      occurredAt: new Date(),
    });
    await db.insert(financeEvents).values({
      id: financeEventId,
      companyId,
      projectId,
      goalId,
      costEventId,
      eventKind: "inference",
      biller: "openrouter",
      amountCents: 5,
      occurredAt: new Date(),
    });
    return { companyId, rootGoalId, goalId, subGoalId, projectId, issueId, costEventId, financeEventId };
  }

  it("deletes a project with linked tasks and cost rows, keeping those rows", async () => {
    const s = await seed();
    const removed = await projectService(db).remove(s.projectId);
    expect(removed?.id).toBe(s.projectId);

    const [issue] = await db.select().from(issues).where(eq(issues.id, s.issueId));
    expect(issue?.projectId).toBeNull();
    expect(issue?.goalId).toBe(s.goalId);
    const [cost] = await db.select().from(costEvents).where(eq(costEvents.id, s.costEventId));
    expect(cost?.projectId).toBeNull();
    const [finance] = await db.select().from(financeEvents).where(eq(financeEvents.id, s.financeEventId));
    expect(finance?.projectId).toBeNull();
  });

  it("deletes a goal with linked tasks, projects, sub-goals and cost rows", async () => {
    const s = await seed();
    const removed = await goalService(db).remove(s.goalId);
    expect(removed?.id).toBe(s.goalId);

    // Tasks and projects move up to the parent goal, so they still trace to a company goal.
    const [issue] = await db.select().from(issues).where(eq(issues.id, s.issueId));
    expect(issue?.goalId).toBe(s.rootGoalId);
    const [project] = await db.select().from(projects).where(eq(projects.id, s.projectId));
    expect(project?.goalId).toBe(s.rootGoalId);
    const links = await db.select().from(projectGoals).where(eq(projectGoals.projectId, s.projectId));
    expect(links.map((l) => l.goalId)).toEqual([s.rootGoalId]);
    const [subGoal] = await db.select().from(goals).where(eq(goals.id, s.subGoalId));
    expect(subGoal?.parentId).toBe(s.rootGoalId);
    const [cost] = await db.select().from(costEvents).where(eq(costEvents.id, s.costEventId));
    expect(cost?.goalId).toBeNull();
    const [finance] = await db.select().from(financeEvents).where(eq(financeEvents.id, s.financeEventId));
    expect(finance?.goalId).toBeNull();
  });

  it("refuses to delete a top-level goal that tasks or projects still point at", async () => {
    const s = await seed();
    await goalService(db).remove(s.goalId);
    await expect(goalService(db).remove(s.rootGoalId)).rejects.toMatchObject({ status: 409 });
    const [root] = await db.select().from(goals).where(eq(goals.id, s.rootGoalId));
    expect(root?.id).toBe(s.rootGoalId);
  });

  it("deletes a top-level goal with only sub-goals and cost rows", async () => {
    const s = await seed();
    await db.delete(issues);
    await projectService(db).remove(s.projectId);
    await db.update(goals).set({ parentId: null }).where(eq(goals.id, s.goalId));
    expect((await goalService(db).remove(s.goalId))?.id).toBe(s.goalId);
    const [subGoal] = await db.select().from(goals).where(eq(goals.id, s.subGoalId));
    expect(subGoal?.parentId).toBeNull();
  });

  it("never rewrites another company's rows", async () => {
    const s = await seed();
    const otherCompanyId = randomUUID();
    const strayGoalId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other",
      issuePrefix: `O${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(goals).values({
      id: strayGoalId,
      companyId: otherCompanyId,
      parentId: s.goalId,
      title: "Stray",
      level: "team",
      status: "active",
    });

    await expect(goalService(db).remove(s.goalId)).rejects.toThrow();
    const [stray] = await db.select().from(goals).where(eq(goals.id, strayGoalId));
    expect(stray?.parentId).toBe(s.goalId);
    const [issue] = await db.select().from(issues).where(eq(issues.id, s.issueId));
    expect(issue?.goalId).toBe(s.goalId);
  });

  it("returns null for a missing goal or project", async () => {
    expect(await goalService(db).remove(randomUUID())).toBeNull();
    expect(await projectService(db).remove(randomUUID())).toBeNull();
  });
});
