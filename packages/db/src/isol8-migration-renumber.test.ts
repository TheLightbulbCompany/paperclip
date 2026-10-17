/**
 * Isol8 fork: the fork migrations were renumbered from 0216-0218 (isol8.3-.6)
 * to 0280-0282 so upstream owns 0216-0279. A production database that ran the
 * OLD numbering must resolve the renamed files as applied (the migrator matches
 * by SQL content hash, and the files are byte-identical), then apply upstream's
 * 0216-0279 and the fork's 0283 on top. This suite builds such a database with
 * the old file names and journal, upgrades it with the real migrator, and
 * checks the result.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { applyPendingMigrations, ensurePostgresDatabase, inspectMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));

// New name -> the name (and journal `when`) it had on v2026.813-isol8.6.
const RENAMED = [
  { now: "0280_routine_circuit_breaker", was: "0216_routine_circuit_breaker", when: 1784300000000 },
  { now: "0281_routine_execution_policy", was: "0217_routine_execution_policy", when: 1784300000001 },
  { now: "0282_lazy_hardball", was: "0218_lazy_hardball", when: 1786821539880 },
];

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function buildLegacyMigrationsFolder(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-isol8-legacy-migrations-"));
  cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "meta"));
  const journal = JSON.parse(fs.readFileSync(path.join(migrationsDir, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
  };
  const upstreamThroughFork = journal.entries.filter((entry) => entry.idx <= 215);
  for (const entry of upstreamThroughFork) {
    fs.copyFileSync(path.join(migrationsDir, `${entry.tag}.sql`), path.join(dir, `${entry.tag}.sql`));
  }
  const legacyEntries = [...upstreamThroughFork];
  RENAMED.forEach((renamed, offset) => {
    fs.copyFileSync(path.join(migrationsDir, `${renamed.now}.sql`), path.join(dir, `${renamed.was}.sql`));
    legacyEntries.push({ idx: 216 + offset, version: "7", when: renamed.when, tag: renamed.was, breakpoints: true });
  });
  fs.writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: legacyEntries }));
  return dir;
}

afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

describeEmbeddedPostgres("isol8 fork migration renumbering", () => {
  it("upgrades a database migrated with the isol8.6 numbering", async () => {
    const cluster = await startEmbeddedPostgresTestDatabase("paperclip-isol8-renumber-");
    cleanups.push(cluster.cleanup);
    const legacyUrl = cluster.connectionString.replace(/\/paperclip$/, "/isol8_legacy");
    await ensurePostgresDatabase(cluster.connectionString.replace(/\/paperclip$/, "/postgres"), "isol8_legacy");

    const legacySql = postgres(legacyUrl, { max: 1, onnotice: () => {} });
    try {
      await migrate(drizzle(legacySql), { migrationsFolder: buildLegacyMigrationsFolder() });
      // The fork's agent-create table exists in its isol8.3 shape.
      const legacyColumns = await legacySql<{ column_name: string }[]>`
        select column_name from information_schema.columns where table_name = 'agent_create_idempotency_keys'`;
      expect(legacyColumns.map((row) => row.column_name)).not.toContain("operation");
      const [company] = await legacySql<{ id: string }[]>`
        insert into companies (id, name, issue_prefix) values (gen_random_uuid(), 'Legacy', 'LEG') returning id`;
      const [agent] = await legacySql<{ id: string }[]>`
        insert into agents (id, company_id, name) values (gen_random_uuid(), ${company!.id}, 'Forge') returning id`;
      await legacySql`
        insert into agent_create_idempotency_keys (company_id, idempotency_key, agent_id, completion_payload)
        values (${company!.id}, 'lightbulb-agent-create:v1:forge', ${agent!.id}, '{}'::jsonb)`;
    } finally {
      await legacySql.end();
    }

    const before = await inspectMigrations(legacyUrl);
    expect(before.status).toBe("needsMigrations");
    if (before.status === "needsMigrations") {
      // The renamed fork files resolve by hash; only upstream's range and 0283 are pending.
      for (const renamed of RENAMED) expect(before.pendingMigrations).not.toContain(`${renamed.now}.sql`);
      expect(before.pendingMigrations).toContain("0216_company_onboarding_seeds.sql");
      expect(before.pendingMigrations).toContain("0283_isol8_idempotent_operations.sql");
    }

    await applyPendingMigrations(legacyUrl);
    const after = await inspectMigrations(legacyUrl);
    expect(after.status).toBe("upToDate");

    const upgradedSql = postgres(legacyUrl, { max: 1, onnotice: () => {} });
    try {
      const columns = await upgradedSql<{ table_name: string; column_name: string }[]>`
        select table_name, column_name from information_schema.columns
        where (table_name = 'routines' and column_name in ('auto_pause_enabled', 'execution_policy'))
           or (table_name = 'agent_create_idempotency_keys' and column_name in ('operation', 'scope', 'resource_id'))`;
      expect(columns).toHaveLength(5);
      // An isol8.3-era agent-create record becomes an agent.create operation.
      const [record] = await upgradedSql<{ operation: string; scope: string; resource_id: string; agent_id: string }[]>`
        select operation, scope, resource_id, agent_id from agent_create_idempotency_keys`;
      expect(record).toMatchObject({ operation: "agent.create", scope: "" });
      expect(record!.resource_id).toBe(record!.agent_id);
      const [{ count }] = await upgradedSql<{ count: number }[]>`
        select count(*)::int as count from company_onboarding_seeds`;
      expect(count).toBe(0);
    } finally {
      await upgradedSql.end();
    }
  }, 120_000);
});
