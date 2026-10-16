CREATE TABLE "agent_create_idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"completion_payload" jsonb NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_create_idempotency_keys" ADD CONSTRAINT "agent_create_idempotency_keys_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_create_idempotency_keys" ADD CONSTRAINT "agent_create_idempotency_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_create_idempotency_keys_company_key_uq" ON "agent_create_idempotency_keys" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "agent_create_idempotency_keys_agent_idx" ON "agent_create_idempotency_keys" USING btree ("agent_id");
