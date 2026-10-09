import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { costEvents, financeEvents, goals, issues, projects } from "@paperclipai/db";

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
    // 23503. Detach them in the same transaction; sub-goals move up one level.
    remove: (id: string) =>
      db.transaction(async (tx) => {
        const goal = await tx.select().from(goals).where(eq(goals.id, id)).then((rows) => rows[0] ?? null);
        if (!goal) return null;
        await tx.update(goals).set({ parentId: goal.parentId }).where(eq(goals.parentId, id));
        await tx.update(issues).set({ goalId: null }).where(eq(issues.goalId, id));
        await tx.update(projects).set({ goalId: null }).where(eq(projects.goalId, id));
        await tx.update(costEvents).set({ goalId: null }).where(eq(costEvents.goalId, id));
        await tx.update(financeEvents).set({ goalId: null }).where(eq(financeEvents.goalId, id));
        return tx
          .delete(goals)
          .where(eq(goals.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
      }),
  };
}
