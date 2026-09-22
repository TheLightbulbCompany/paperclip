import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agents,
  companies,
  companyMemberships,
  createDb,
  idempotentOperations,
  projects,
  routines,
} from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { companyRoutes } from "../routes/companies.js";
import { routineRoutes } from "../routes/routines.js";
import { accessService } from "../services/access.js";
import { companyService } from "../services/companies.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Isol8 fork: company, routine and agent API-key creates honor Idempotency-Key
// with the same replay semantics as agent create
// (agent-create-idempotency-routes.test.ts).

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres idempotent create route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("idempotent create routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-idempotent-creates-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    const rows = await db.select({ id: companies.id }).from(companies);
    for (const row of rows) await companyService(db).remove(row.id);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function boardApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api/companies", companyRoutes(db));
    app.use("/api", routineRoutes(db));
    app.use(errorHandler);
    return app;
  }

  function instanceAdmin(userId: string) {
    return { type: "board", userId, source: "session", isInstanceAdmin: true, companyIds: [] };
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Idempotent Co",
      issuePrefix: `I${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Forge",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Ops", status: "in_progress" });
    const userId = randomUUID();
    const access = accessService(db);
    const membership = await access.ensureMembership(companyId, "user", userId, "owner", "active");
    await access.setMemberPermissions(companyId, membership.id, [{ permissionKey: "tasks:assign" }], userId);
    return { companyId, agentId, projectId, userId };
  }

  describe("POST /api/companies", () => {
    it("serializes concurrent same-key creates into one company", async () => {
      const userId = randomUUID();
      const app = boardApp(instanceAdmin(userId));
      const [left, right] = await Promise.all([
        request(app).post("/api/companies").set("Idempotency-Key", "company:owner-1").send({ name: "Acme" }),
        request(app).post("/api/companies").set("Idempotency-Key", "company:owner-1").send({ name: "Acme" }),
      ]);

      expect([left.status, right.status].sort()).toEqual([200, 201]);
      expect(left.body.id).toBe(right.body.id);
      expect(await db.select().from(companies)).toHaveLength(1);
      expect(
        await db.select().from(companyMemberships).where(eq(companyMemberships.companyId, left.body.id)),
      ).toHaveLength(1);
      expect(
        await db.select().from(activityLog).where(eq(activityLog.action, "company.created")),
      ).toHaveLength(1);
    });

    it("replays the original company when a retry changes its body", async () => {
      const app = boardApp(instanceAdmin(randomUUID()));
      const first = await request(app).post("/api/companies").set("Idempotency-Key", "company:k").send({ name: "Acme" }).expect(201);
      const replay = await request(app).post("/api/companies").set("Idempotency-Key", "company:k").send({ name: "Other" }).expect(200);
      expect(replay.body.id).toBe(first.body.id);
      expect(replay.body.name).toBe("Acme");
    });

    it("refuses replay-only on a miss without creating", async () => {
      const app = boardApp(instanceAdmin(randomUUID()));
      const response = await request(app)
        .post("/api/companies")
        .set("Idempotency-Key", "company:missing")
        .set("Idempotency-Replay-Only", "true")
        .send({ name: "Acme" })
        .expect(409);
      expect(response.body.code).toBe("company_create_idempotency_replay_miss");
      expect(await db.select().from(companies)).toHaveLength(0);
    });

    it("scopes a key to its creating principal and keeps keyless creates unchanged", async () => {
      const a = await request(boardApp(instanceAdmin(randomUUID()))).post("/api/companies").set("Idempotency-Key", "company:shared").send({ name: "A" }).expect(201);
      const b = await request(boardApp(instanceAdmin(randomUUID()))).post("/api/companies").set("Idempotency-Key", "company:shared").send({ name: "B" }).expect(201);
      const app = boardApp(instanceAdmin(randomUUID()));
      const c = await request(app).post("/api/companies").send({ name: "C" }).expect(201);
      const d = await request(app).post("/api/companies").send({ name: "C" }).expect(201);
      expect(new Set([a.body.id, b.body.id, c.body.id, d.body.id]).size).toBe(4);
    });

    it("releases the key when its company is deleted", async () => {
      const app = boardApp(instanceAdmin(randomUUID()));
      const first = await request(app).post("/api/companies").set("Idempotency-Key", "company:recreate").send({ name: "Acme" }).expect(201);
      await companyService(db).remove(first.body.id);
      expect(await db.select().from(idempotentOperations)).toHaveLength(0);
      const second = await request(app).post("/api/companies").set("Idempotency-Key", "company:recreate").send({ name: "Acme" }).expect(201);
      expect(second.body.id).not.toBe(first.body.id);
    });
  });

  describe("POST /api/companies/:companyId/routines", () => {
    function routineBody(agentId: string, projectId: string, title = "Nightly CEO progress") {
      return { title, assigneeAgentId: agentId, projectId, priority: "medium" };
    }

    it("serializes concurrent same-key creates into one routine", async () => {
      const { companyId, agentId, projectId, userId } = await seedCompany();
      const app = boardApp({ type: "board", userId, source: "session", isInstanceAdmin: false, companyIds: [companyId] });
      const path = `/api/companies/${companyId}/routines`;
      const [left, right] = await Promise.all([
        request(app).post(path).set("Idempotency-Key", `nightly-ceo:${companyId}`).send(routineBody(agentId, projectId)),
        request(app).post(path).set("Idempotency-Key", `nightly-ceo:${companyId}`).send(routineBody(agentId, projectId)),
      ]);

      expect([left.status, right.status].sort(), JSON.stringify([left.body, right.body])).toEqual([200, 201]);
      expect(left.body.id).toBe(right.body.id);
      expect(await db.select().from(routines).where(eq(routines.companyId, companyId))).toHaveLength(1);
      expect(
        await db.select().from(activityLog).where(eq(activityLog.action, "routine.created")),
      ).toHaveLength(1);
    });

    it("replays the original routine and refuses a replay-only miss", async () => {
      const { companyId, agentId, projectId, userId } = await seedCompany();
      const app = boardApp({ type: "board", userId, source: "session", isInstanceAdmin: false, companyIds: [companyId] });
      const path = `/api/companies/${companyId}/routines`;
      const first = await request(app).post(path).set("Idempotency-Key", "routine:k").send(routineBody(agentId, projectId)).expect(201);
      const replay = await request(app).post(path).set("Idempotency-Key", "routine:k").send(routineBody(agentId, projectId, "Renamed")).expect(200);
      expect(replay.body.id).toBe(first.body.id);
      expect(replay.body.title).toBe("Nightly CEO progress");

      const miss = await request(app)
        .post(path)
        .set("Idempotency-Key", "routine:missing")
        .set("Idempotency-Replay-Only", "true")
        .send(routineBody(agentId, projectId))
        .expect(409);
      expect(miss.body.code).toBe("routine_create_idempotency_replay_miss");
      expect(await db.select().from(routines).where(eq(routines.companyId, companyId))).toHaveLength(1);
    });

    it("scopes a key to its company", async () => {
      const one = await seedCompany();
      const two = await seedCompany();
      const key = "routine:shared";
      const a = await request(boardApp({ type: "board", userId: one.userId, source: "session", isInstanceAdmin: false, companyIds: [one.companyId] }))
        .post(`/api/companies/${one.companyId}/routines`).set("Idempotency-Key", key).send(routineBody(one.agentId, one.projectId)).expect(201);
      const b = await request(boardApp({ type: "board", userId: two.userId, source: "session", isInstanceAdmin: false, companyIds: [two.companyId] }))
        .post(`/api/companies/${two.companyId}/routines`).set("Idempotency-Key", key).send(routineBody(two.agentId, two.projectId)).expect(201);
      expect(a.body.id).not.toBe(b.body.id);
    });
  });

  describe("POST /api/agents/:id/keys", () => {
    function agentApp() {
      const app = express();
      app.use(express.json());
      app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
      app.use("/api", agentRoutes(db));
      app.use(errorHandler);
      return app;
    }

    async function liveKeys(agentId: string) {
      return db.select().from(agentApiKeys).where(and(eq(agentApiKeys.agentId, agentId), isNull(agentApiKeys.revokedAt)));
    }

    it("replays the same token to concurrent same-key requests", async () => {
      const { agentId } = await seedCompany();
      const app = agentApp();
      const path = `/api/agents/${agentId}/keys`;
      const [left, right] = await Promise.all([
        request(app).post(path).set("Idempotency-Key", `owner:mcp-key:${agentId}`).send({ name: "lightbulb-mcp-server" }),
        request(app).post(path).set("Idempotency-Key", `owner:mcp-key:${agentId}`).send({ name: "lightbulb-mcp-server" }),
      ]);

      expect([left.status, right.status].sort()).toEqual([200, 201]);
      expect(left.body.id).toBe(right.body.id);
      expect(left.body.token).toEqual(expect.any(String));
      expect(left.body.token).toBe(right.body.token);
      expect(await liveKeys(agentId)).toHaveLength(1);
    });

    it("rotates once the replay window has passed and scrubs stale tokens", async () => {
      const { agentId } = await seedCompany();
      const app = agentApp();
      const path = `/api/agents/${agentId}/keys`;
      const first = await request(app).post(path).set("Idempotency-Key", "mcp:rotate").send({ name: "mcp" }).expect(201);
      const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
      await db.update(idempotentOperations).set({ createdAt: stale });

      const rotated = await request(app).post(path).set("Idempotency-Key", "mcp:rotate").send({ name: "mcp" }).expect(200);
      expect(rotated.body.id).not.toBe(first.body.id);
      expect(rotated.body.token).not.toBe(first.body.token);
      const live = await liveKeys(agentId);
      expect(live.map((key) => key.id)).toEqual([rotated.body.id]);

      const again = await request(app).post(path).set("Idempotency-Key", "mcp:rotate").send({ name: "mcp" }).expect(200);
      expect(again.body.token).toBe(rotated.body.token);

      // A stale record's plaintext is scrubbed by any later keyed key create.
      await db.update(idempotentOperations).set({ createdAt: stale });
      await request(app).post(path).set("Idempotency-Key", "mcp:other").send({ name: "mcp" }).expect(201);
      const [scrubbed] = await db.select().from(idempotentOperations).where(eq(idempotentOperations.idempotencyKey, "mcp:rotate"));
      expect(scrubbed?.completionPayload).toEqual({});
    });

    it("rotates a replayed key that was revoked", async () => {
      const { agentId } = await seedCompany();
      const app = agentApp();
      const path = `/api/agents/${agentId}/keys`;
      const first = await request(app).post(path).set("Idempotency-Key", "mcp:revoked").send({ name: "mcp" }).expect(201);
      await request(app).delete(`${path}/${first.body.id}`).expect(200);
      const replay = await request(app).post(path).set("Idempotency-Key", "mcp:revoked").send({ name: "mcp" }).expect(200);
      expect(replay.body.id).not.toBe(first.body.id);
      expect((await liveKeys(agentId)).map((key) => key.id)).toEqual([replay.body.id]);
    });

    it("refuses a key already used for a different agent in the company", async () => {
      const { companyId, agentId } = await seedCompany();
      const otherAgentId = randomUUID();
      await db.insert(agents).values({
        id: otherAgentId,
        companyId,
        name: "Scout",
        role: "engineer",
        status: "active",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      const app = agentApp();
      await request(app).post(`/api/agents/${agentId}/keys`).set("Idempotency-Key", "mcp:same").send({ name: "mcp" }).expect(201);
      const response = await request(app)
        .post(`/api/agents/${otherAgentId}/keys`)
        .set("Idempotency-Key", "mcp:same")
        .send({ name: "mcp" })
        .expect(409);
      expect(response.body.code).toBe("agent_key_create_idempotency_agent_mismatch");
      expect(await liveKeys(otherAgentId)).toHaveLength(0);
    });
  });
});
