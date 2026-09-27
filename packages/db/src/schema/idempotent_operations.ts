import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

/**
 * Isol8 fork: durable Idempotency-Key records for create endpoints.
 *
 * Born as the agent-create table (migration 0282) and generalized in 0283; the
 * SQL name is kept so databases that ran 0282 need no rename. A key is scoped
 * by (company, scope, operation): company-scoped creates leave `scope` empty,
 * company create — which has no company yet — scopes by the creating
 * principal. Deleting the company or the agent a record points at cascades the
 * record, so an intentional re-create can reuse the same business key.
 */
export const idempotentOperations = pgTable(
  "agent_create_idempotency_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    scope: text("scope").notNull().default(""),
    operation: text("operation").notNull().default("agent.create"),
    idempotencyKey: text("idempotency_key").notNull(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    resourceId: uuid("resource_id"),
    completionPayload: jsonb("completion_payload").$type<Record<string, unknown>>().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    operationKeyIdx: uniqueIndex("agent_create_idempotency_keys_operation_key_uq").on(
      table.companyId,
      table.scope,
      table.operation,
      table.idempotencyKey,
    ),
    agentIdx: index("agent_create_idempotency_keys_agent_idx").on(table.agentId),
  }),
);
