import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  approvals,
  assets,
  companies,
  costEvents,
  createDb,
  decisionBundles,
  decisions,
  financeEvents,
  goals,
  heartbeatRuns,
  issues,
  issueThreadInteractions,
  issueWatchdogs,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent delete FK tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent delete FK sweep", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-delete-fk-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(decisions);
    await db.delete(decisionBundles);
    await db.delete(issueWatchdogs);
    await db.delete(issueThreadInteractions);
    await db.delete(costEvents);
    await db.delete(financeEvents);
    await db.delete(assets);
    await db.delete(approvals);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("deletes an agent whose work is referenced by assets, decisions, and finance rows, preserving the evidence", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const assetId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Lens",
      role: "general",
      status: "idle",
      adapterType: "openclaw_gateway",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "run issue",
      status: "done",
      createdByAgentId: agentId,
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "completed",
    });
    // The FK that broke prod deletion: an asset created by the agent.
    await db.insert(assets).values({
      id: assetId,
      companyId,
      provider: "s3",
      objectKey: "companies/test/asset.txt",
      contentType: "text/plain",
      byteSize: 5,
      sha256: "a".repeat(64),
      createdByAgentId: agentId,
    });
    await db.insert(approvals).values({
      companyId,
      type: "generic",
      payload: {},
      requestedByAgentId: agentId,
    });
    await db.insert(financeEvents).values({
      companyId,
      agentId,
      eventKind: "inference",
      biller: "aws",
      amountCents: 5,
      occurredAt: new Date(),
    });
    await db.insert(costEvents).values({
      companyId,
      agentId,
      provider: "anthropic",
      model: "claude",
      costCents: 5,
      occurredAt: new Date(),
    });
    await db.insert(goals).values({ companyId, title: "goal", ownerAgentId: agentId });
    await db.insert(projects).values({ companyId, name: "proj", leadAgentId: agentId });
    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId,
      kind: "ask_user_questions",
      status: "pending",
      payload: {},
      createdByAgentId: agentId,
    });
    await db.insert(issueWatchdogs).values({
      companyId,
      issueId,
      watchdogAgentId: agentId,
    });
    const bundleId = randomUUID();
    await db.insert(decisionBundles).values({
      id: bundleId,
      companyId,
      title: "b",
      summary: "s",
      originAgentId: agentId,
      originIssueId: issueId,
      originRunId: runId,
    });
    await db.insert(decisions).values({
      companyId,
      bundleId,
      title: "d",
      summary: "s",
      body: "body",
      options: [],
      expiresAt: new Date(Date.now() + 86_400_000),
      signedSpec: "spec",
      targetSnapshots: {},
      originAgentId: agentId,
      originIssueId: issueId,
      originRunId: runId,
      status: "pending",
    });

    const removed = await agentService(db).remove(agentId);
    expect(removed).not.toBeNull();

    // Agent gone.
    expect(await db.select().from(agents).where(eq(agents.id, agentId))).toHaveLength(0);
    // Evidence preserved with attribution nulled.
    const asset = await db.select().from(assets).where(eq(assets.id, assetId));
    expect(asset).toHaveLength(1);
    expect(asset[0]!.createdByAgentId).toBeNull();
    expect((await db.select().from(approvals))[0]!.requestedByAgentId).toBeNull();
    expect((await db.select().from(financeEvents))[0]!.agentId).toBeNull();
    expect((await db.select().from(goals))[0]!.ownerAgentId).toBeNull();
    expect((await db.select().from(projects))[0]!.leadAgentId).toBeNull();
    // Operational rows owned by the agent are gone.
    expect(await db.select().from(costEvents)).toHaveLength(0);
    expect(await db.select().from(decisions)).toHaveLength(0);
    expect(await db.select().from(decisionBundles)).toHaveLength(0);
    expect(await db.select().from(issueWatchdogs)).toHaveLength(0);
  });
});
