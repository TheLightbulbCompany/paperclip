import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { routineRuns, routines } from "@paperclipai/db";
import { instanceSettingsService } from "./instance-settings.js";
import { logActivity } from "./activity-log.js";

// Circuit breaker: track consecutive routine-run failures and auto-pause a
// routine once it crosses its effective threshold. A successful (completed)
// outcome resets the counter; a failed/blocked outcome increments it.
// Enforcement is free — a paused routine is dropped by tickScheduledTriggers'
// status="active" filter.
//
// This lives in its own module (not inside routineService) because the
// authoritative success/failure signal is a routine-execution ISSUE reaching a
// terminal status, and that transition is written in issuesSvc.update — the
// universal choke point that ALL paths use, including the recovery service
// (reconcile_stranded_assigned_issue), which blocks issues WITHOUT going through
// syncRunStatusForIssue. Hooking the run-finalize path alone misses the dominant
// recovery-driven failure mode.
export async function applyRoutineOutcome(
  executor: Db,
  routineId: string,
  companyId: string,
  outcome: "completed" | "failed",
): Promise<void> {
  if (outcome === "completed") {
    await executor
      .update(routines)
      .set({ consecutiveFailureCount: 0, updatedAt: new Date() })
      .where(and(eq(routines.id, routineId), ne(routines.consecutiveFailureCount, 0)));
    return;
  }
  const [updated] = await executor
    .update(routines)
    .set({
      consecutiveFailureCount: sql`${routines.consecutiveFailureCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(routines.id, routineId))
    .returning({
      status: routines.status,
      count: routines.consecutiveFailureCount,
      enabled: routines.autoPauseEnabled,
      threshold: routines.autoPauseThreshold,
    });
  if (!updated || updated.status !== "active") return;

  const general = await instanceSettingsService(executor).getGeneral();
  const effectiveEnabled = updated.enabled ?? general.autoPauseDefaultEnabled;
  const effectiveThreshold = updated.threshold ?? general.autoPauseDefaultThreshold;
  if (!effectiveEnabled || updated.count < effectiveThreshold) return;

  const [paused] = await executor
    .update(routines)
    .set({
      status: "paused",
      autoPausedAt: new Date(),
      autoPauseReason: "consecutive_failures",
      updatedAt: new Date(),
    })
    .where(and(eq(routines.id, routineId), eq(routines.status, "active")))
    .returning({ id: routines.id });
  if (!paused) return;

  await logActivity(executor, {
    companyId,
    actorType: "system",
    actorId: "routine-scheduler",
    action: "routine.auto_paused",
    entityType: "routine",
    entityId: routineId,
    details: {
      reason: "consecutive_failures",
      threshold: effectiveThreshold,
      consecutiveFailureCount: updated.count,
    },
  });
}

// Resolve the routine for a routine-execution issue's run and apply the outcome.
// Called from issuesSvc.update when such an issue reaches a terminal status.
export async function recordRoutineOutcomeForIssueRun(
  executor: Db,
  originRunId: string,
  companyId: string,
  outcome: "completed" | "failed",
): Promise<void> {
  const [run] = await executor
    .select({ routineId: routineRuns.routineId })
    .from(routineRuns)
    .where(eq(routineRuns.id, originRunId));
  if (!run) return;
  await applyRoutineOutcome(executor, run.routineId, companyId, outcome);
}
