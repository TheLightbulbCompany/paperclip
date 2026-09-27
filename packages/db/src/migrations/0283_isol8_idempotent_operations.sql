ALTER TABLE "agent_create_idempotency_keys" ALTER COLUMN "company_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_create_idempotency_keys" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_create_idempotency_keys" ADD COLUMN IF NOT EXISTS "operation" text DEFAULT 'agent.create' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_create_idempotency_keys" ADD COLUMN IF NOT EXISTS "scope" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_create_idempotency_keys" ADD COLUMN IF NOT EXISTS "resource_id" uuid;--> statement-breakpoint
UPDATE "agent_create_idempotency_keys" SET "resource_id" = "agent_id" WHERE "resource_id" IS NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "agent_create_idempotency_keys_company_key_uq";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_create_idempotency_keys_operation_key_uq" ON "agent_create_idempotency_keys" USING btree ("company_id","scope","operation","idempotency_key");
