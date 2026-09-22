import { and, eq, sql } from "drizzle-orm";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { idempotentOperations } from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../errors.js";

/**
 * Isol8 fork: one durable Idempotency-Key mechanism for create endpoints
 * (agents, companies, routines, agent API keys).
 *
 * A same-key request is serialized on a transaction-scoped advisory lock, so a
 * crashed holder releases it with its connection — there is no lease to
 * expire. Under the lock the record is read: a hit replays the original
 * resource, a miss runs the create in the SAME transaction as the record
 * insert, so a resource never commits without its record. Requests without the
 * header keep upstream behavior.
 */

export type IdempotentOperationName =
  | "agent.create"
  | "company.create"
  | "routine.create"
  | "agent_key.create";

export type IdempotencyRequest = { key: string; replayOnly: boolean };

export type IdempotentOperationTarget = {
  operation: IdempotentOperationName;
  key: string;
  /** Owning company; null only for company.create, which has none yet. */
  companyId: string | null;
  /** Principal scope for company.create; empty for company-scoped creates. */
  scope?: string;
};

export type IdempotentOperationRecord = typeof idempotentOperations.$inferSelect;

/** Parses Idempotency-Key / Idempotency-Replay-Only; null when no key was sent. */
export function readIdempotencyHeaders(req: Request): IdempotencyRequest | null {
  const rawKey = req.header("Idempotency-Key");
  const key = rawKey?.trim() || null;
  if (rawKey !== undefined && (!key || key.length > 255)) {
    throw unprocessable("Idempotency-Key must contain between 1 and 255 characters");
  }
  const replayOnlyHeader = req.header("Idempotency-Replay-Only")?.trim().toLowerCase();
  if (replayOnlyHeader !== undefined && !["true", "false"].includes(replayOnlyHeader)) {
    throw unprocessable("Idempotency-Replay-Only must be true or false");
  }
  const replayOnly = replayOnlyHeader === "true";
  if (replayOnly && !key) throw unprocessable("Idempotency-Replay-Only requires Idempotency-Key");
  return key ? { key, replayOnly } : null;
}

// Agent create keeps the lock string it has used since isol8.3, so old and new
// builds serialize against each other during a rolling deploy.
function lockKey(target: IdempotentOperationTarget) {
  return `${target.operation.replace(".", "-")}:idempotency:${target.companyId ?? target.scope ?? ""}:${target.key}`;
}

async function lockAndRead(tx: Db, target: IdempotentOperationTarget) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey(target)}, 0))`);
  return tx
    .select()
    .from(idempotentOperations)
    .where(and(
      // company.create has no company yet; its principal scope is the key's owner.
      target.companyId === null
        ? sql`true`
        : eq(idempotentOperations.companyId, target.companyId),
      eq(idempotentOperations.scope, target.scope ?? ""),
      eq(idempotentOperations.operation, target.operation),
      eq(idempotentOperations.idempotencyKey, target.key),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

export type IdempotentCreateResult<T> = {
  resourceId: string;
  /** Company to scope and cascade the record by (the new one for company.create). */
  companyId: string;
  agentId?: string | null;
  completionPayload?: Record<string, unknown>;
  result: T;
};

/**
 * Replays or creates under one Idempotency-Key. `replay` receives the stored
 * record and must return the original resource, or null when it is gone
 * (answered with 409). `create` runs inside the locked transaction.
 */
export async function runIdempotentOperation<T>(
  db: Db,
  target: IdempotentOperationTarget,
  options: { replayOnly?: boolean },
  handlers: {
    replay: (record: IdempotentOperationRecord, tx: Db) => Promise<T | null>;
    create: (tx: Db) => Promise<IdempotentCreateResult<T>>;
  },
): Promise<{ result: T; replayed: boolean; record: IdempotentOperationRecord }> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const existing = await lockAndRead(tx, target);
    if (existing) {
      const result = await handlers.replay(existing, tx);
      if (result === null) {
        throw conflict(`Idempotent ${target.operation} target no longer exists`, {
          code: `${target.operation.replace(".", "_")}_idempotency_target_missing`,
        });
      }
      return { result, replayed: true, record: existing };
    }
    if (options.replayOnly) {
      throw conflict(`No existing ${target.operation} operation matches this idempotency key`, {
        code: `${target.operation.replace(".", "_")}_idempotency_replay_miss`,
      });
    }
    const created = await handlers.create(tx);
    const [record] = await tx
      .insert(idempotentOperations)
      .values({
        companyId: created.companyId,
        scope: target.scope ?? "",
        operation: target.operation,
        idempotencyKey: target.key,
        agentId: created.agentId ?? null,
        resourceId: created.resourceId,
        completionPayload: created.completionPayload ?? {},
      })
      .returning();
    return { result: created.result, replayed: false, record: record! };
  });
}

/**
 * Second phase for creates with non-transactional follow-up work (agent
 * create's instruction files and grants): runs `complete` at most once per
 * record, under the same lock, then scrubs the recovery payload.
 */
export async function completeIdempotentOperation<T>(
  db: Db,
  target: IdempotentOperationTarget,
  complete: (record: IdempotentOperationRecord) => Promise<T>,
  alreadyComplete: (record: IdempotentOperationRecord) => Promise<T>,
): Promise<T> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const record = await lockAndRead(tx, target);
    if (!record) throw notFound(`${target.operation} idempotency record not found`);
    if (record.completedAt) return alreadyComplete(record);
    const result = await complete(record);
    await tx
      .update(idempotentOperations)
      .set({ completedAt: new Date(), completionPayload: {} })
      .where(eq(idempotentOperations.id, record.id));
    return result;
  });
}

/** Overwrites a record's resource and payload in place (agent key rotation). */
export async function rebindIdempotentOperation(
  tx: Db,
  recordId: string,
  values: { resourceId: string; completionPayload: Record<string, unknown> },
) {
  await tx
    .update(idempotentOperations)
    .set({ ...values, createdAt: new Date(), completedAt: null })
    .where(eq(idempotentOperations.id, recordId));
}
