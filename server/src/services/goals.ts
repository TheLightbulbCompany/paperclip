import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { costEvents, financeEvents, goals, issues, projectGoals, projects } from "@paperclipai/db";
import { conflict } from "../errors.js";

type GoalReader = Pick<Db, "select">;

export async function getDefaultCompanyGoal(db: GoalReader, companyId: string) {
  const activeRootGoal = await db
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.companyId, companyId),
        eq(goals.level, "company"),
        eq(goals.status, "active"),
        isNull(goals.parentId),
      ),
    )
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
  if (activeRootGoal) return activeRootGoal;

  const anyRootGoal = await db
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.companyId, companyId),
        eq(goals.level, "company"),
        isNull(goals.parentId),
      ),
    )
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
  if (anyRootGoal) return anyRootGoal;

  return db
    .select()
    .from(goals)
    .where(and(eq(goals.companyId, companyId), eq(goals.level, "company")))
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
}

export function goalService(db: Db) {
  return {
    list: (companyId: string) => db.select().from(goals).where(eq(goals.companyId, companyId)),

    getById: (id: string) =>
      db
        .select()
        .from(goals)
        .where(eq(goals.id, id))
        .then((rows) => rows[0] ?? null),

    getDefaultCompanyGoal: (companyId: string) => getDefaultCompanyGoal(db, companyId),

    create: (companyId: string, data: Omit<typeof goals.$inferInsert, "companyId">) =>
      db
        .insert(goals)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]),

    update: (id: string, data: Partial<typeof goals.$inferInsert>) =>
      db
        .update(goals)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(goals.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    // isol8: these FKs into goals.id have no delete policy, so a linked task,
    // project, sub-goal or cost/finance row made the delete fail with SQLSTATE
    // 23503. Move them up to the parent goal in the same transaction, so every
    // task still traces to a company goal. The row lock blocks new references
    // (their FK check takes KEY SHARE) until we commit; every sweep is scoped to
    // the goal's own company, so a cross-company row is refused, never rewritten.
    remove: (id: string) =>
      db.transaction(async (tx) => {
        const goal = await tx
          .select()
          .from(goals)
          .where(eq(goals.id, id))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!goal) return null;
        const { companyId, parentId } = goal;
        if (!parentId) {
          const linked = (
            await Promise.all([
              tx.select({ id: issues.id }).from(issues)
                .where(and(eq(issues.companyId, companyId), eq(issues.goalId, id))).limit(1),
              tx.select({ id: projects.id }).from(projects)
                .where(and(eq(projects.companyId, companyId), eq(projects.goalId, id))).limit(1),
              tx.select({ id: projectGoals.projectId }).from(projectGoals)
                .where(and(eq(projectGoals.companyId, companyId), eq(projectGoals.goalId, id))).limit(1),
            ])
          ).flat();
          if (linked.length > 0) {
            throw conflict("This is a top-level goal with tasks or projects. Move them to another goal first.");
          }
        }
        await tx
          .update(goals)
          .set({ parentId })
          .where(and(eq(goals.companyId, companyId), eq(goals.parentId, id)));
        await tx
          .update(issues)
          .set({ goalId: parentId })
          .where(and(eq(issues.companyId, companyId), eq(issues.goalId, id)));
        await tx
          .update(projects)
          .set({ goalId: parentId })
          .where(and(eq(projects.companyId, companyId), eq(projects.goalId, id)));
        if (parentId) {
          const linkedProjects = await tx
            .select({ projectId: projectGoals.projectId })
            .from(projectGoals)
            .where(and(eq(projectGoals.companyId, companyId), eq(projectGoals.goalId, id)));
          if (linkedProjects.length > 0) {
            await tx
              .insert(projectGoals)
              .values(linkedProjects.map(({ projectId }) => ({ projectId, goalId: parentId, companyId })))
              .onConflictDoNothing();
          }
        }
        await tx
          .update(costEvents)
          .set({ goalId: null })
          .where(and(eq(costEvents.companyId, companyId), eq(costEvents.goalId, id)));
        await tx
          .update(financeEvents)
          .set({ goalId: null })
          .where(and(eq(financeEvents.companyId, companyId), eq(financeEvents.goalId, id)));
        return tx
          .delete(goals)
          .where(eq(goals.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
      }),
  };
}
