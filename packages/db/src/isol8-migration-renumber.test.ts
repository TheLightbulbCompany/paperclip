/**
 * Isol8 fork: the fork migrations moved from 0280-0283 (v2026.916.1-isol8.1..4)
 * to 0306-0309 so upstream owns 0280-0305 (v2026.1001.0..v2026.1012.0). A
 * production database that ran the OLD numbering must resolve the renamed files
 * as applied (the migrator matches by SQL content hash, and the files are
 * byte-identical), then apply upstream's 0280-0305 on top. This suite builds
 * such a database with the old file names and journal, upgrades it with the
 * real migrator, and checks the result.
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

// New name -> the name (and journal `when`) it had on v2026.916.1-isol8.4.
const RENAMED = [
  { now: "0306_routine_circuit_breaker", was: "0280_routine_circuit_breaker", when: 1789390281191 },
  { now: "0307_routine_execution_policy", was: "0281_routine_execution_policy", when: 1789390281192 },
  { now: "0308_lazy_hardball", was: "0282_lazy_hardball", when: 1789390281193 },
  { now: "0309_isol8_idempotent_operations", was: "0283_isol8_idempotent_operations", when: 1789390281194 },
];
const LAST_UPSTREAM_IDX_BEFORE_FORK = 279;

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
  const upstreamThroughFork = journal.entries.filter((entry) => entry.idx <= LAST_UPSTREAM_IDX_BEFORE_FORK);
  for (const entry of upstreamThroughFork) {
    fs.copyFileSync(path.join(migrationsDir, `${entry.tag}.sql`), path.join(dir, `${entry.tag}.sql`));
  }
  const legacyEntries = [...upstreamThroughFork];
  RENAMED.forEach((renamed, offset) => {
    fs.copyFileSync(path.join(migrationsDir, `${renamed.now}.sql`), path.join(dir, `${renamed.was}.sql`));
    legacyEntries.push({ idx: LAST_UPSTREAM_IDX_BEFORE_FORK + 1 + offset, version: "7", when: renamed.when, tag: renamed.was, breakpoints: true });
  });
  fs.writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: legacyEntries }));
  return dir;
}

afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

describeEmbeddedPostgres("isol8 fork migration renumbering", () => {
  it("upgrades a database migrated with the isol8.4 numbering", async () => {
    const cluster = await startEmbeddedPostgresTestDatabase("paperclip-isol8-renumber-");
    cleanups.push(cluster.cleanup);
    const legacyUrl = cluster.connectionString.replace(/\/paperclip$/, "/isol8_legacy");
    await ensurePostgresDatabase(cluster.connectionString.replace(/\/paperclip$/, "/postgres"), "isol8_legacy");

    const legacySql = postgres(legacyUrl, { max: 1, onnotice: () => {} });
    try {
      await migrate(drizzle(legacySql), { migrationsFolder: buildLegacyMigrationsFolder() });
      const [company] = await legacySql<{ id: string }[]>`
        insert into companies (id, name, issue_prefix) values (gen_random_uuid(), 'Legacy', 'LEG') returning id`;
      const [agent] = await legacySql<{ id: string }[]>`
        insert into agents (id, company_id, name) values (gen_random_uuid(), ${company!.id}, 'Forge') returning id`;
      await legacySql`
        insert into agent_create_idempotency_keys (company_id, idempotency_key, agent_id, resource_id, completion_payload)
        values (${company!.id}, 'lightbulb-agent-create:v1:forge', ${agent!.id}, ${agent!.id}, '{}'::jsonb)`;
    } finally {
      await legacySql.end();
    }

    const before = await inspectMigrations(legacyUrl);
    expect(before.status).toBe("needsMigrations");
    if (before.status === "needsMigrations") {
      // The renamed fork files resolve by hash; only upstream's new range is pending.
      for (const renamed of RENAMED) expect(before.pendingMigrations).not.toContain(`${renamed.now}.sql`);
      expect(before.pendingMigrations).toContain("0280_unique_genesis.sql");
      expect(before.pendingMigrations).toContain("0305_chubby_vin_gonzales.sql");
      expect(before.pendingMigrations).toHaveLength(26);
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
      // The isol8.4 idempotency record survives the upgrade untouched.
      const [record] = await upgradedSql<{ operation: string; scope: string; resource_id: string; agent_id: string }[]>`
        select operation, scope, resource_id, agent_id from agent_create_idempotency_keys`;
      expect(record).toMatchObject({ operation: "agent.create", scope: "" });
      expect(record!.resource_id).toBe(record!.agent_id);
    } finally {
      await upgradedSql.end();
    }
  }, 120_000);
});
