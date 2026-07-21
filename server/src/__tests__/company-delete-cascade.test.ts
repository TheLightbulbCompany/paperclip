import { randomUUID } from "node:crypto";
import { eq, getTableName, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agentConfigRevisions,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  approvalComments,
  approvals,
  assets,
  budgetIncidents,
  budgetPolicies,
  companies,
  companyLogos,
  companySkills,
  companySkillTestRuns,
  companySkillVersions,
  costEvents,
  createDb,
  feedbackExports,
  feedbackVotes,
  financeEvents,
  goals,
  heartbeatRunEvents,
  heartbeatRuns,
  heartbeatRunWatchdogDecisions,
  inboxDismissals,
  invites,
  issueComments,
  issueExecutionDecisions,
  issueInboxArchives,
  issueReadStates,
  issueThreadInteractions,
  issueWatchdogs,
  issues,
  joinRequests,
  projects,
  routines,
  secretAccessEvents,
  toolMcpGateways,
  toolProfiles,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { COMPANY_DELETE_SEQUENCE, companyService } from "../services/companies.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping company delete cascade tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/** One foreign-key edge of the live database: childTable.childColumns -> parentTable. */
type FkEdge = {
  constraintName: string;
  childTable: string;
  parentTable: string;
  onDelete: string;
  childColumns: string;
  anyChildColumnNotNull: boolean;
};

async function loadPublicFkGraph(db: ReturnType<typeof createDb>): Promise<FkEdge[]> {
  const rows = await db.execute(sql`
    select
      con.conname as constraint_name,
      child.relname as child_table,
      parent.relname as parent_table,
      case con.confdeltype
        when 'a' then 'no action'
        when 'r' then 'restrict'
        when 'c' then 'cascade'
        when 'n' then 'set null'
        when 'd' then 'set default'
        else con.confdeltype::text
      end as on_delete,
      (
        select string_agg(att.attname, ', ' order by cols.ord)
        from unnest(con.conkey) with ordinality as cols(attnum, ord)
        join pg_attribute att on att.attrelid = con.conrelid and att.attnum = cols.attnum
      ) as child_columns,
      (
        select bool_or(att.attnotnull)
        from unnest(con.conkey) as cols(attnum)
        join pg_attribute att on att.attrelid = con.conrelid and att.attnum = cols.attnum
      ) as any_child_column_not_null
    from pg_constraint con
    join pg_class child on child.oid = con.conrelid
    join pg_class parent on parent.oid = con.confrelid
    join pg_namespace ns on ns.oid = child.relnamespace
    where con.contype = 'f' and ns.nspname = 'public'
    order by child.relname, con.conname
  `);
  return [...rows].map((row) => ({
    constraintName: String(row.constraint_name),
    childTable: String(row.child_table),
    parentTable: String(row.parent_table),
    onDelete: String(row.on_delete),
    childColumns: String(row.child_columns),
    anyChildColumnNotNull: row.any_child_column_not_null === true,
  }));
}

async function loadPublicTableNames(db: ReturnType<typeof createDb>): Promise<Set<string>> {
  const rows = await db.execute(sql`
    select cls.relname as table_name
    from pg_class cls
    join pg_namespace ns on ns.oid = cls.relnamespace
    where ns.nspname = 'public' and cls.relkind = 'r'
  `);
  return new Set([...rows].map((row) => String(row.table_name)));
}

describeEmbeddedPostgres("company delete cascade", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-delete-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("deletes a company whose object graph populates every FK path", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const goalId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const approvalId = randomUUID();
    const budgetPolicyId = randomUUID();
    const costEventId = randomUUID();
    const skillId = randomUUID();
    const skillVersionId = randomUUID();
    const toolProfileId = randomUUID();
    const feedbackVoteId = randomUUID();
    const assetId = randomUUID();
    const inviteId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Doomed Corp",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Atlas",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "timer",
      status: "completed",
    });

    // goals <- projects.goal_id (no ON DELETE): deleting goals before projects
    // is the historical 500 on companies with goal-linked projects.
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Q3 revenue",
      ownerAgentId: agentId,
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Rocket",
      goalId,
      leadAgentId: agentId,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      goalId,
      title: "Ship it",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      createdByUserId: "user-1",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "completed",
      contextSnapshot: { issueId },
      wakeupRequestId,
    });

    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId,
      agentId,
      seq: 1,
      eventType: "log",
      message: "run started",
    });

    await db.insert(agentTaskSessions).values({
      id: randomUUID(),
      companyId,
      agentId,
      adapterType: "codex_local",
      taskKey: `issue:${issueId}`,
      lastRunId: runId,
    });

    await db.insert(agentApiKeys).values({
      id: randomUUID(),
      agentId,
      companyId,
      name: "ci key",
      keyHash: randomUUID(),
    });

    await db.insert(agentRuntimeState).values({
      agentId,
      companyId,
      adapterType: "codex_local",
    });

    // cost/finance events pinned to the run: the old order deleted
    // heartbeat_runs before cost_events/finance_events and cost_events before
    // finance_events, violating both run FKs and finance_events.cost_event_id.
    await db.insert(costEvents).values({
      id: costEventId,
      companyId,
      agentId,
      issueId,
      goalId,
      projectId,
      heartbeatRunId: runId,
      provider: "bedrock",
      model: "sonnet",
      costCents: 42,
      occurredAt: new Date(),
    });

    await db.insert(financeEvents).values({
      id: randomUUID(),
      companyId,
      eventKind: "cost",
      biller: "bedrock",
      amountCents: 42,
      occurredAt: new Date(),
      costEventId,
      heartbeatRunId: runId,
      agentId,
      goalId,
      projectId,
    });

    await db.insert(activityLog).values({
      id: randomUUID(),
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      action: "heartbeat.completed",
      entityType: "issue",
      entityId: issueId,
      runId,
      details: {},
    });

    await db.insert(heartbeatRunWatchdogDecisions).values({
      id: randomUUID(),
      companyId,
      runId,
      decision: "continue",
    });

    // issue_thread_interactions.issue_id has no ON DELETE: this is the exact
    // constraint the production DELETE /api/companies/:id 500 pointed at.
    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId,
      issueId,
      kind: "question",
      payload: {},
      createdByAgentId: agentId,
      resolvedByAgentId: agentId,
    });

    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      authorAgentId: agentId,
      body: "Blocking comment",
    });

    await db.insert(issueReadStates).values({
      id: randomUUID(),
      companyId,
      issueId,
      userId: "user-1",
    });

    await db.insert(issueInboxArchives).values({
      id: randomUUID(),
      companyId,
      issueId,
      userId: "user-1",
    });

    await db.insert(feedbackVotes).values({
      id: feedbackVoteId,
      companyId,
      issueId,
      targetType: "comment",
      targetId: randomUUID(),
      authorUserId: "user-1",
      vote: "up",
    });

    await db.insert(feedbackExports).values({
      id: randomUUID(),
      companyId,
      feedbackVoteId,
      issueId,
      authorUserId: "user-1",
      targetType: "comment",
      targetId: randomUUID(),
      vote: "up",
      targetSummary: {},
    });

    await db.insert(issueWatchdogs).values({
      id: randomUUID(),
      companyId,
      issueId,
      watchdogAgentId: agentId,
    });

    await db.insert(issueExecutionDecisions).values({
      id: randomUUID(),
      companyId,
      issueId,
      stageId: randomUUID(),
      stageType: "kickoff",
      actorAgentId: agentId,
      outcome: "proceed",
      body: "go ahead",
      createdByRunId: runId,
    });

    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "budget_exception",
      payload: {},
      requestedByAgentId: agentId,
    });

    await db.insert(approvalComments).values({
      id: randomUUID(),
      companyId,
      approvalId,
      authorAgentId: agentId,
      body: "looks fine",
    });

    await db.insert(budgetPolicies).values({
      id: budgetPolicyId,
      companyId,
      scopeType: "company",
      scopeId: companyId,
      windowKind: "daily",
    });

    await db.insert(budgetIncidents).values({
      id: randomUUID(),
      companyId,
      policyId: budgetPolicyId,
      approvalId,
      scopeType: "company",
      scopeId: companyId,
      metric: "cost_cents",
      windowKind: "daily",
      windowStart: new Date(),
      windowEnd: new Date(),
      thresholdType: "hard",
      amountLimit: 100,
      amountObserved: 250,
    });

    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: "paperclipai/paperclip/deleter",
      slug: "deleter",
      name: "Deleter",
      markdown: "# Deleter",
    });

    await db.insert(companySkillVersions).values({
      id: skillVersionId,
      companyId,
      companySkillId: skillId,
      revisionNumber: 1,
    });

    await db.insert(companySkillTestRuns).values({
      id: randomUUID(),
      companyId,
      skillId,
      inputSnapshot: "input",
      skillVersionId,
      agentId,
      issueId,
    });

    await db.insert(toolProfiles).values({
      id: toolProfileId,
      companyId,
      profileKey: "default",
      name: "Default",
    });

    await db.insert(toolMcpGateways).values({
      id: randomUUID(),
      companyId,
      name: "Gateway",
      slug: "gateway",
      profileId: toolProfileId,
      agentId,
      issueId,
      projectId,
    });

    await db.insert(workspaceRuntimeServices).values({
      id: randomUUID(),
      companyId,
      scopeType: "issue",
      serviceName: "dev-server",
      status: "running",
      lifecycle: "active",
      provider: "process",
      projectId,
      issueId,
      ownerAgentId: agentId,
      startedByRunId: runId,
    });

    await db.insert(secretAccessEvents).values({
      id: randomUUID(),
      companyId,
      secretId: null,
      provider: "env",
      actorType: "agent",
      consumerType: "agent",
      consumerId: agentId,
      outcome: "granted",
    });

    await db.insert(inboxDismissals).values({
      id: randomUUID(),
      companyId,
      userId: "user-1",
      itemKey: "welcome-card",
    });

    await db.insert(agentConfigRevisions).values({
      id: randomUUID(),
      companyId,
      agentId,
      beforeConfig: {},
      afterConfig: {},
    });

    await db.insert(routines).values({
      id: randomUUID(),
      companyId,
      title: "Weekly report",
      assigneeAgentId: agentId,
      projectId,
      goalId,
    });

    await db.insert(assets).values({
      id: assetId,
      companyId,
      provider: "local",
      objectKey: `logos/${assetId}.png`,
      contentType: "image/png",
      byteSize: 12,
      sha256: "0".repeat(64),
      createdByAgentId: agentId,
    });

    await db.insert(companyLogos).values({
      id: randomUUID(),
      companyId,
      assetId,
    });

    await db.insert(invites).values({
      id: inviteId,
      companyId,
      tokenHash: randomUUID(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    await db.insert(joinRequests).values({
      id: randomUUID(),
      inviteId,
      companyId,
      requestType: "agent",
      requestIp: "127.0.0.1",
      agentName: "Recruit",
      createdAgentId: agentId,
    });

    // Control rows in a second company must survive the scoped delete.
    const otherCompanyId = randomUUID();
    const otherAgentId = randomUUID();
    const otherIssueId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Survivor Inc",
      issuePrefix: `S${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: otherAgentId,
      companyId: otherCompanyId,
      name: "Keeper",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: otherIssueId,
      companyId: otherCompanyId,
      title: "Keep me",
      status: "todo",
      priority: "medium",
      createdByUserId: "user-2",
    });
    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId: otherCompanyId,
      issueId: otherIssueId,
      kind: "question",
      payload: {},
    });

    const removed = await companyService(db).remove(companyId);

    expect(removed?.id).toBe(companyId);
    await expect(db.select().from(companies).where(eq(companies.id, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(agents).where(eq(agents.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(goals).where(eq(goals.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(projects).where(eq(projects.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(issues).where(eq(issues.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).resolves.toHaveLength(0);
    await expect(
      db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, companyId)),
    ).resolves.toHaveLength(0);
    await expect(
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)),
    ).resolves.toHaveLength(0);
    await expect(
      db.select().from(agentTaskSessions).where(eq(agentTaskSessions.companyId, companyId)),
    ).resolves.toHaveLength(0);
    await expect(db.select().from(agentApiKeys).where(eq(agentApiKeys.companyId, companyId))).resolves.toHaveLength(0);
    await expect(
      db.select().from(agentRuntimeState).where(eq(agentRuntimeState.companyId, companyId)),
    ).resolves.toHaveLength(0);
    await expect(db.select().from(costEvents).where(eq(costEvents.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(financeEvents).where(eq(financeEvents.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).resolves.toHaveLength(0);
    await expect(
      db.select().from(heartbeatRunWatchdogDecisions).where(eq(heartbeatRunWatchdogDecisions.companyId, companyId)),
    ).resolves.toHaveLength(0);
    await expect(
      db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, companyId)),
    ).resolves.toHaveLength(0);
    await expect(db.select().from(issueComments).where(eq(issueComments.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(issueReadStates).where(eq(issueReadStates.companyId, companyId))).resolves.toHaveLength(0);
    await expect(
      db.select().from(issueInboxArchives).where(eq(issueInboxArchives.companyId, companyId)),
    ).resolves.toHaveLength(0);
    await expect(db.select().from(feedbackVotes).where(eq(feedbackVotes.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(feedbackExports).where(eq(feedbackExports.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(issueWatchdogs).where(eq(issueWatchdogs.companyId, companyId))).resolves.toHaveLength(0);
    await expect(
      db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.companyId, companyId)),
    ).resolves.toHaveLength(0);
    await expect(db.select().from(approvals).where(eq(approvals.companyId, companyId))).resolves.toHaveLength(0);
    await expect(
      db.select().from(approvalComments).where(eq(approvalComments.companyId, companyId)),
    ).resolves.toHaveLength(0);
    await expect(db.select().from(budgetPolicies).where(eq(budgetPolicies.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(budgetIncidents).where(eq(budgetIncidents.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(companySkills).where(eq(companySkills.companyId, companyId))).resolves.toHaveLength(0);
    await expect(
      db.select().from(companySkillVersions).where(eq(companySkillVersions.companyId, companyId)),
    ).resolves.toHaveLength(0);
    await expect(
      db.select().from(companySkillTestRuns).where(eq(companySkillTestRuns.companyId, companyId)),
    ).resolves.toHaveLength(0);
    await expect(db.select().from(toolProfiles).where(eq(toolProfiles.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(toolMcpGateways).where(eq(toolMcpGateways.companyId, companyId))).resolves.toHaveLength(0);
    await expect(
      db.select().from(workspaceRuntimeServices).where(eq(workspaceRuntimeServices.companyId, companyId)),
    ).resolves.toHaveLength(0);
    await expect(
      db.select().from(secretAccessEvents).where(eq(secretAccessEvents.companyId, companyId)),
    ).resolves.toHaveLength(0);
    await expect(db.select().from(inboxDismissals).where(eq(inboxDismissals.companyId, companyId))).resolves.toHaveLength(0);
    await expect(
      db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.companyId, companyId)),
    ).resolves.toHaveLength(0);
    await expect(db.select().from(routines).where(eq(routines.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(assets).where(eq(assets.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(companyLogos).where(eq(companyLogos.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(invites).where(eq(invites.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(joinRequests).where(eq(joinRequests.companyId, companyId))).resolves.toHaveLength(0);

    // The unrelated company's rows are untouched.
    await expect(db.select().from(companies).where(eq(companies.id, otherCompanyId))).resolves.toHaveLength(1);
    await expect(db.select().from(agents).where(eq(agents.companyId, otherCompanyId))).resolves.toHaveLength(1);
    await expect(db.select().from(issues).where(eq(issues.companyId, otherCompanyId))).resolves.toHaveLength(1);
    await expect(
      db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, otherCompanyId)),
    ).resolves.toHaveLength(1);
  }, 30_000);

  // The fixture above can only exercise FK paths somebody remembered to seed.
  // These three tests pin the delete order against the LIVE schema instead, so
  // a migration that adds a table or FK the sequence does not handle fails CI
  // even when no fixture row hits it (the way company_skill_test_runs slipped
  // through the 2026.7 rebase and broke issue deletes).

  it("covers every blocking company reference with the delete sequence", async () => {
    const sequenceNames = COMPANY_DELETE_SEQUENCE.map((table) => getTableName(table));
    const sequenced = new Set(sequenceNames);

    // The sequence itself must be duplicate-free and made of real tables —
    // otherwise the graph checks below would silently validate a phantom order.
    expect(sequenceNames.length).toBe(sequenced.size);
    const liveTables = await loadPublicTableNames(db);
    expect(sequenceNames.filter((name) => !liveTables.has(name))).toEqual([]);

    // CASCADE company FKs are emptied by the final companies delete and
    // SET NULL / SET DEFAULT ones cannot block it, so only NO ACTION /
    // RESTRICT references demand an explicit slot in the sequence.
    const edges = await loadPublicFkGraph(db);
    const uncovered = edges
      .filter((edge) => edge.parentTable === "companies")
      .filter((edge) => edge.onDelete === "no action" || edge.onDelete === "restrict")
      .filter((edge) => !sequenced.has(edge.childTable))
      .map(
        (edge) =>
          `${edge.childTable}.${edge.childColumns} -> companies is ON DELETE ${edge.onDelete.toUpperCase()} ` +
          `(${edge.constraintName}) but ${edge.childTable} is not in COMPANY_DELETE_SEQUENCE`,
      );
    expect(uncovered).toEqual([]);
  });

  it("orders every blocking FK edge child-before-parent within the sequence", async () => {
    const sequenceNames = COMPANY_DELETE_SEQUENCE.map((table) => getTableName(table));
    const position = new Map<string, number>(sequenceNames.map((name, index) => [name, index]));
    position.set("companies", sequenceNames.length); // the companies row goes last

    const edges = await loadPublicFkGraph(db);
    const misordered = edges
      .filter((edge) => edge.onDelete === "no action" || edge.onDelete === "restrict")
      .filter((edge) => edge.childTable !== edge.parentTable)
      .filter((edge) => position.has(edge.childTable) && position.has(edge.parentTable))
      .filter((edge) => (position.get(edge.childTable) ?? 0) > (position.get(edge.parentTable) ?? 0))
      .map(
        (edge) =>
          `${edge.childTable}.${edge.childColumns} -> ${edge.parentTable} (${edge.onDelete}; ${edge.constraintName}): ` +
          `${edge.childTable} must be deleted before ${edge.parentTable}`,
      );
    expect(misordered).toEqual([]);
  });

  it("replays the delete sequence against the live FK graph without hitting a blocking edge", async () => {
    const edges = await loadPublicFkGraph(db);
    const childEdgesByParent = new Map<string, FkEdge[]>();
    for (const edge of edges) {
      const list = childEdgesByParent.get(edge.parentTable) ?? [];
      list.push(edge);
      childEdgesByParent.set(edge.parentTable, list);
    }

    const deleteOrder = [...COMPANY_DELETE_SEQUENCE.map((table) => getTableName(table)), "companies"];
    const emptied = new Set<string>();
    const violations = new Set<string>();
    const setNullHazards = new Set<string>();

    // Each step runs `DELETE FROM table WHERE company_id = :id` as ONE
    // statement, so the tables reachable through ON DELETE CASCADE edges are
    // emptied within that same statement and Postgres checks NO ACTION
    // constraints only after it completes. A blocking edge is therefore safe
    // when its child dies in the same statement's cascade closure or was
    // emptied by an earlier step — anything else is the exact FK error the
    // production 500 threw.
    for (const stepTable of deleteOrder) {
      const closure = new Set<string>([stepTable]);
      const pending = [stepTable];
      while (pending.length > 0) {
        const table = pending.pop()!;
        for (const edge of childEdgesByParent.get(table) ?? []) {
          if (edge.onDelete === "cascade" && !closure.has(edge.childTable)) {
            closure.add(edge.childTable);
            pending.push(edge.childTable);
          }
        }
      }

      for (const table of closure) {
        for (const edge of childEdgesByParent.get(table) ?? []) {
          if (edge.onDelete === "cascade" || edge.onDelete === "set default") continue;
          if (edge.onDelete === "set null") {
            if (edge.anyChildColumnNotNull) {
              setNullHazards.add(
                `${edge.childTable}.${edge.childColumns} -> ${table} is ON DELETE SET NULL onto a NOT NULL column (${edge.constraintName})`,
              );
            }
            continue;
          }
          if (closure.has(edge.childTable) || emptied.has(edge.childTable)) continue;
          violations.add(
            `step "${stepTable}" (deleting ${table}) violates ${edge.constraintName}: ` +
            `${edge.childTable}.${edge.childColumns} (${edge.onDelete}) is not emptied by any earlier step ` +
            `or by this statement's cascade`,
          );
        }
      }

      for (const table of closure) emptied.add(table);
    }

    expect([...violations]).toEqual([]);
    expect([...setNullHazards]).toEqual([]);
  });
});
