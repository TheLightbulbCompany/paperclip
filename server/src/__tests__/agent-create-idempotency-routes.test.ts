import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  idempotentOperations,
  agents,
  companyMemberships,
  companies,
  createDb,
  principalPermissionGrants,
} from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent create idempotency route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("agent create idempotency routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-create-idempotency-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.execute(sql.raw(
      "ALTER TABLE activity_log DROP CONSTRAINT IF EXISTS reject_agent_created_for_recovery_test",
    ));
    const createdAgents = await db.select({ adapterConfig: agents.adapterConfig }).from(agents);
    await Promise.all(createdAgents.map((agent) => {
      const rootPath = (agent.adapterConfig as Record<string, unknown>)?.instructionsRootPath;
      return typeof rootPath === "string"
        ? fs.rm(rootPath, { recursive: true, force: true })
        : Promise.resolve();
    }));
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(idempotentOperations);
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use((req, _res, next) => {
      const testUserId = req.header("x-test-user-id");
      if (testUserId && req.actor.type === "board") req.actor.userId = testUserId;
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany(name = "Agent Idempotency") {
    return db.insert(companies).values({
      id: randomUUID(),
      name,
      issuePrefix: `AI${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    }).returning().then((rows) => rows[0]!);
  }

  function agentBody() {
    return {
      name: "Forge",
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
    };
  }

  it("serializes concurrent retries and applies create side effects once", async () => {
    const company = await seedCompany();
    const app = createApp();
    const path = `/api/companies/${company.id}/agents`;

    const [left, right] = await Promise.all([
      request(app).post(path).set("Idempotency-Key", "hire:forge:v1").send(agentBody()),
      request(app).post(path).set("Idempotency-Key", "hire:forge:v1").send(agentBody()),
    ]);

    expect([left.status, right.status].sort()).toEqual([200, 201]);
    expect(left.body.id).toBe(right.body.id);
    expect(await db.select().from(agents).where(eq(agents.companyId, company.id))).toHaveLength(1);
    expect(
      await db.select().from(idempotentOperations)
        .where(eq(idempotentOperations.companyId, company.id)),
    ).toHaveLength(1);
    expect(
      await db.select().from(activityLog).where(eq(activityLog.action, "agent.created")),
    ).toHaveLength(1);
    expect(await db.select().from(companyMemberships)).toHaveLength(1);
    expect(await db.select().from(principalPermissionGrants)).toHaveLength(1);
  });

  it("replays the original agent when a retry changes its volatile payload", async () => {
    const company = await seedCompany();
    const app = createApp();
    const path = `/api/companies/${company.id}/agents`;

    const first = await request(app)
      .post(path)
      .set("Idempotency-Key", "hire:forge:v2")
      .send(agentBody())
      .expect(201);
    const replay = await request(app)
      .post(path)
      .set("Idempotency-Key", "hire:forge:v2")
      .send({
        ...agentBody(),
        name: "Retry payload must not create Forge 2",
        adapterConfig: { command: "echo retry" },
      })
      .expect(200);

    expect(replay.body.id).toBe(first.body.id);
    expect(replay.body.name).toBe("Forge");
    expect(await db.select().from(agents).where(eq(agents.companyId, company.id))).toHaveLength(1);
  });

  it("atomically refuses replay-only when the key has no existing operation", async () => {
    const company = await seedCompany();
    const app = createApp();
    const path = `/api/companies/${company.id}/agents`;

    const response = await request(app)
      .post(path)
      .set("Idempotency-Key", "hire:forge:missing")
      .set("Idempotency-Replay-Only", "true")
      .send(agentBody())
      .expect(409);

    expect(response.body.code).toBe("agent_create_idempotency_replay_miss");
    expect(await db.select().from(agents).where(eq(agents.companyId, company.id))).toHaveLength(0);
    expect(await db.select().from(idempotentOperations)).toHaveLength(0);
  });

  it("allows replay-only to resume an existing operation without creating another agent", async () => {
    const company = await seedCompany();
    const app = createApp();
    const path = `/api/companies/${company.id}/agents`;
    const first = await request(app)
      .post(path)
      .set("Idempotency-Key", "hire:forge:existing")
      .send(agentBody())
      .expect(201);

    const replay = await request(app)
      .post(path)
      .set("Idempotency-Key", "hire:forge:existing")
      .set("Idempotency-Replay-Only", "true")
      .send(agentBody())
      .expect(200);

    expect(replay.body.id).toBe(first.body.id);
    expect(await db.select().from(agents).where(eq(agents.companyId, company.id))).toHaveLength(1);
  });

  it("resumes incomplete post-create side effects on replay", async () => {
    const company = await seedCompany();
    const app = createApp();
    const path = `/api/companies/${company.id}/agents`;
    const key = "hire:forge:resume";

    await db.execute(sql.raw(
      "ALTER TABLE activity_log ADD CONSTRAINT reject_agent_created_for_recovery_test "
      + "CHECK (action <> 'agent.created')",
    ));
    await request(app)
      .post(path)
      .set("x-test-user-id", "original-user")
      .set("Idempotency-Key", key)
      .send({
        ...agentBody(),
        adapterType: "claude_local",
        instructionsBundle: { files: { "AGENTS.md": "Original instructions" } },
      })
      .expect(500);
    await db.execute(sql.raw(
      "ALTER TABLE activity_log DROP CONSTRAINT reject_agent_created_for_recovery_test",
    ));

    const [createdAgent] = await db.select().from(agents).where(eq(agents.companyId, company.id));
    expect(createdAgent).toBeDefined();
    const originalAdapterConfig = createdAgent!.adapterConfig as Record<string, unknown>;
    expect(originalAdapterConfig.instructionsRootPath).toEqual(expect.any(String));
    await fs.rm(originalAdapterConfig.instructionsRootPath as string, { recursive: true, force: true });
    await db.update(agents).set({ adapterConfig: {} }).where(eq(agents.id, createdAgent!.id));
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);

    const [incompleteOperation] = await db.select().from(idempotentOperations);
    expect(incompleteOperation?.completedAt).toBeNull();
    expect(incompleteOperation?.completionPayload).toMatchObject({
      instructionsBundle: { files: { "AGENTS.md": "Original instructions" } },
      grantedByUserId: "original-user",
      actor: { actorId: "original-user" },
    });

    const replay = await request(app)
      .post(path)
      .set("x-test-user-id", "retry-user")
      .set("Idempotency-Key", key)
      .send({
        ...agentBody(),
        adapterType: "claude_local",
        instructionsBundle: { files: { "AGENTS.md": "Retry instructions must not win" } },
      })
      .expect(200);

    expect(replay.body.id).toBe(createdAgent!.id);
    await expect(fs.readFile(replay.body.adapterConfig.instructionsFilePath, "utf8"))
      .resolves.toBe("Original instructions");
    expect(await db.select().from(agents).where(eq(agents.companyId, company.id))).toHaveLength(1);
    expect(await db.select().from(companyMemberships)).toHaveLength(1);
    const [grant] = await db.select().from(principalPermissionGrants);
    expect(grant?.grantedByUserId).toBe("original-user");
    const activities = await db.select().from(activityLog).where(eq(activityLog.action, "agent.created"));
    expect(activities).toHaveLength(1);
    expect(activities[0]?.actorId).toBe("original-user");
    const [operation] = await db.select().from(idempotentOperations);
    expect(operation?.completedAt).toBeInstanceOf(Date);
    expect(operation?.completionPayload).toEqual({});
  });

  it("scopes a key to its company and allows ordinary creates without a key", async () => {
    const firstCompany = await seedCompany("First Company");
    const secondCompany = await seedCompany("Second Company");
    const app = createApp();

    const first = await request(app)
      .post(`/api/companies/${firstCompany.id}/agents`)
      .set("Idempotency-Key", "hire:forge:shared")
      .send(agentBody())
      .expect(201);
    const second = await request(app)
      .post(`/api/companies/${secondCompany.id}/agents`)
      .set("Idempotency-Key", "hire:forge:shared")
      .send(agentBody())
      .expect(201);
    const noKeyOne = await request(app)
      .post(`/api/companies/${firstCompany.id}/agents`)
      .send(agentBody())
      .expect(201);
    const noKeyTwo = await request(app)
      .post(`/api/companies/${firstCompany.id}/agents`)
      .send(agentBody())
      .expect(201);

    expect(new Set([first.body.id, second.body.id, noKeyOne.body.id, noKeyTwo.body.id]).size).toBe(4);
  });

  it("releases the key when its agent is hard-deleted", async () => {
    const company = await seedCompany();
    const app = createApp();
    const path = `/api/companies/${company.id}/agents`;

    const first = await request(app)
      .post(path)
      .set("Idempotency-Key", "hire:forge:delete-reuse")
      .send(agentBody())
      .expect(201);
    await db.delete(agents).where(eq(agents.id, first.body.id));
    const recreated = await request(app)
      .post(path)
      .set("Idempotency-Key", "hire:forge:delete-reuse")
      .send(agentBody())
      .expect(201);

    expect(recreated.body.id).not.toBe(first.body.id);
    expect(recreated.body.name).toBe("Forge");
  });

  it("rejects blank and oversized idempotency keys", async () => {
    const company = await seedCompany();
    const app = createApp();
    const path = `/api/companies/${company.id}/agents`;

    await request(app).post(path).set("Idempotency-Key", "").send(agentBody()).expect(422);
    await request(app).post(path).set("Idempotency-Key", "x".repeat(256)).send(agentBody()).expect(422);
    await request(app)
      .post(path)
      .set("Idempotency-Replay-Only", "true")
      .send(agentBody())
      .expect(422);
    await request(app)
      .post(path)
      .set("Idempotency-Key", "hire:forge:invalid-mode")
      .set("Idempotency-Replay-Only", "sometimes")
      .send(agentBody())
      .expect(422);
    expect(await db.select().from(agents)).toHaveLength(0);
  });
});
