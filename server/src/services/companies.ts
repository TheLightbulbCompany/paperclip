import { and, count, eq, gte, inArray, isNull, like, lt, ne, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companies,
  companyLogos,
  assets,
  agents,
  agentApiKeys,
  agentConfigRevisions,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  budgetIncidents,
  budgetPolicies,
  cases,
  decisionArchiveNotificationOutbox,
  decisionBundles,
  decisionQueueItems,
  decisionQueues,
  decisionRetention,
  decisionTargetIssues,
  decisionTriage,
  decisionTriageEvents,
  decisions,
  issues,
  issueApprovals,
  issueAttachments,
  issueComments,
  issueDocuments,
  issueExecutionDecisions,
  issueInboxArchives,
  issuePlanDecompositions,
  issueRecoveryActions,
  issueReferenceMentions,
  issueRelations,
  issueThreadInteractions,
  issueTreeHoldMembers,
  issueTreeHolds,
  issueWatchdogs,
  issueWorkProducts,
  feedbackExports,
  feedbackVotes,
  inboxDismissals,
  projects,
  projectGoals,
  projectWorkspaces,
  goals,
  heartbeatRuns,
  runIdentityContexts,
  heartbeatRunEvents,
  heartbeatRunWatchdogDecisions,
  costEvents,
  financeEvents,
  issueReadStates,
  approvalComments,
  approvals,
  activityLog,
  companySecretBindings,
  companySecretProposals,
  companySecrets,
  joinRequests,
  invites,
  principalPermissionGrants,
  companyMemberships,
  companySkills,
  companySkillTestRuns,
  documents,
  documentAnnotationAnchorSnapshots,
  documentAnnotationComments,
  documentAnnotationThreads,
  routineDocuments,
  routineRuns,
  routineTriggers,
  routineRevisions,
  routines,
  secretAccessEvents,
  toolMcpGateways,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { notFound, unprocessable } from "../errors.js";
import { isCloudManagedInstance } from "./cloud-instance.js";
import {
  MAX_ISSUE_PREFIX_ATTEMPTS,
  deriveIssuePrefixBase,
  isIssuePrefixConflict,
  issuePrefixSuffixForAttempt,
  pickAvailableIssuePrefix,
  rekeyCompanyIssueIdentifiers,
} from "./issue-prefix.js";
import { environmentService } from "./environments.js";
import { heartbeatService } from "./heartbeat.js";
import { logActivity } from "./activity-log.js";
import { builtInAgentService } from "./built-in-agents.js";


const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CompanyScopedTable = PgTable & { companyId: PgColumn };

// The ordered delete sequence remove() executes, children-before-parents so no
// NO ACTION / RESTRICT foreign key is violated mid-way: every table listed
// either references companies without ON DELETE CASCADE or references (also
// non-cascading) a table deleted later in the sequence. Company-scoped tables
// absent here are emptied by ON DELETE CASCADE from one of the explicit
// deletes (or the final companies delete). The company-delete-cascade test
// replays this sequence against the live FK graph, so a new table that breaks
// coverage or ordering fails CI instead of 500ing DELETE /api/companies/:id.
export const COMPANY_DELETE_SEQUENCE: readonly CompanyScopedTable[] = [
  // Decisions + queues (children first, then decisions, then bundles). The whole
  // family lands ahead of heartbeat_runs / agent_api_keys / issues / agents:
  // every table here holds a NO ACTION reference to at least one of those.
  // (decision_effect_executions has no company_id — it is emptied by the
  // ON DELETE CASCADE from decisions below, which still runs ahead of issues.)
  decisionTargetIssues,
  decisionTriageEvents,
  decisionTriage,
  decisionQueueItems,
  decisionQueues,
  decisionRetention,
  decisionArchiveNotificationOutbox,
  decisions,
  decisionBundles,
  // Run + ledger rows (before heartbeat_runs / goals / projects / agents).
  heartbeatRunEvents,
  heartbeatRunWatchdogDecisions,
  agentTaskSessions,
  activityLog,
  financeEvents,
  costEvents,
  runIdentityContexts,
  heartbeatRuns,
  agentWakeupRequests,
  agentApiKeys,
  agentRuntimeState,
  agentConfigRevisions,
  // Approvals + budget enforcement (incidents reference approvals and policies).
  approvalComments,
  issueApprovals,
  budgetIncidents,
  approvals,
  budgetPolicies,
  // Skill studio (test runs RESTRICT skill versions, agents, and issues).
  companySkillTestRuns,
  companySkills,
  // Secrets (proposals reference companies with NO ACTION).
  companySecretProposals,
  companySecretBindings,
  secretAccessEvents,
  companySecrets,
  // Membership + access.
  joinRequests,
  invites,
  principalPermissionGrants,
  companyMemberships,
  inboxDismissals,
  toolMcpGateways,
  // Routines (before agents via assignee_agent_id).
  routineRuns,
  routineTriggers,
  routineRevisions,
  routineDocuments,
  routines,
  // Documents + annotations.
  documentAnnotationAnchorSnapshots,
  documentAnnotationComments,
  documentAnnotationThreads,
  documents,
  // Issue graph (everything referencing issues, then issues themselves).
  issueComments,
  issueReadStates,
  issueAttachments,
  issueDocuments,
  issueExecutionDecisions,
  issueInboxArchives,
  issuePlanDecompositions,
  issueRecoveryActions,
  issueReferenceMentions,
  issueRelations,
  issueThreadInteractions,
  issueTreeHoldMembers,
  issueTreeHolds,
  issueWatchdogs,
  issueWorkProducts,
  feedbackExports,
  feedbackVotes,
  issues,
  // Workspaces + structure (projects before goals: projects.goal_id).
  workspaceRuntimeServices,
  projectWorkspaces,
  projectGoals,
  projects,
  goals,
  companyLogos,
  assets,
  agents,
];

export interface CompanyActivityActor {
  actorType: "user" | "agent" | "system" | "plugin";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
}

const SYSTEM_COMPANY_ACTOR: CompanyActivityActor = {
  actorType: "system",
  actorId: "system",
  agentId: null,
  runId: null,
};

export function companyService(db: Db) {
  const environmentsSvc = environmentService(db);
  const heartbeat = heartbeatService(db);
  const builtInAgents = builtInAgentService(db);

  type CompanyTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

  async function applyArchiveCascadeInTx(tx: CompanyTx, id: string) {
    const pausedAgentRows = await tx
      .update(agents)
      .set({
        status: "paused",
        pauseReason: "company_archived",
        pausedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(agents.companyId, id),
        notInArray(agents.status, ["paused", "terminated", "pending_approval"]),
      ))
      .returning({ id: agents.id });

    const activeRunIds = await tx
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, id),
        inArray(heartbeatRuns.status, ["queued", "running"]),
      ))
      .then((rows) => rows.map((row) => row.id));

    await tx
      .update(agentWakeupRequests)
      .set({
        status: "cancelled",
        error: "Cancelled because the company was archived",
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(agentWakeupRequests.companyId, id),
        inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution", "claimed"]),
        isNull(agentWakeupRequests.runId),
      ));

    return { agentsPaused: pausedAgentRows.length, activeRunIds };
  }

  async function finalizeArchive(
    id: string,
    actor: CompanyActivityActor,
    cascade: { agentsPaused: number; activeRunIds: string[] },
  ) {
    for (const runId of cascade.activeRunIds) {
      await heartbeat.cancelRun(runId, "Cancelled because the company was archived");
    }

    await logActivity(db, {
      companyId: id,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
      action: "company.archived",
      entityType: "company",
      entityId: id,
      details: {
        agentsPaused: cascade.agentsPaused,
        runsCancelled: cascade.activeRunIds.length,
      },
    });
  }

  const companySelection = {
    id: companies.id,
    name: companies.name,
    description: companies.description,
    status: companies.status,
    issuePrefix: companies.issuePrefix,
    issueCounter: companies.issueCounter,
    budgetMonthlyCents: companies.budgetMonthlyCents,
    spentMonthlyCents: companies.spentMonthlyCents,
    defaultResponsibleUserId: companies.defaultResponsibleUserId,
    requireBoardApprovalForNewAgents: companies.requireBoardApprovalForNewAgents,
    interactionResolverGovernance: companies.interactionResolverGovernance,
    feedbackDataSharingEnabled: companies.feedbackDataSharingEnabled,
    feedbackDataSharingConsentAt: companies.feedbackDataSharingConsentAt,
    feedbackDataSharingConsentByUserId: companies.feedbackDataSharingConsentByUserId,
    feedbackDataSharingTermsVersion: companies.feedbackDataSharingTermsVersion,
    logoAssetId: companyLogos.assetId,
    createdAt: companies.createdAt,
    updatedAt: companies.updatedAt,
  };

  function enrichCompany<T extends { logoAssetId: string | null }>(company: T) {
    return {
      ...company,
      logoUrl: company.logoAssetId ? `/api/assets/${company.logoAssetId}/content` : null,
    };
  }

  function currentUtcMonthWindow(now = new Date()) {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    return {
      start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
      end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
    };
  }

  async function getMonthlySpendByCompanyIds(
    companyIds: string[],
    database: Pick<Db, "select"> = db,
  ) {
    if (companyIds.length === 0) return new Map<string, number>();
    const { start, end } = currentUtcMonthWindow();
    const rows = await database
        .select({
          companyId: costEvents.companyId,
          spentMonthlyCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
        })
      .from(costEvents)
      .where(
        and(
          inArray(costEvents.companyId, companyIds),
          gte(costEvents.occurredAt, start),
          lt(costEvents.occurredAt, end),
        ),
      )
      .groupBy(costEvents.companyId);
    return new Map(rows.map((row) => [row.companyId, Number(row.spentMonthlyCents ?? 0)]));
  }

  async function hydrateCompanySpend<T extends { id: string; spentMonthlyCents: number }>(
    rows: T[],
    database: Pick<Db, "select"> = db,
  ) {
    const spendByCompanyId = await getMonthlySpendByCompanyIds(rows.map((row) => row.id), database);
    return rows.map((row) => ({
      ...row,
      spentMonthlyCents: spendByCompanyId.get(row.id) ?? 0,
    }));
  }

  function getCompanyQuery(database: Pick<Db, "select">) {
    return database
      .select(companySelection)
      .from(companies)
      .leftJoin(companyLogos, eq(companyLogos.companyId, companies.id));
  }

  /**
   * Decides whether a rename must move the company onto a new issue prefix, and
   * returns the exact prefix pair to re-key.
   *
   * Self-hosted companies pick their prefix from the name at creation and keep
   * it, so a rename leaves the prefix alone. On a hosted/managed instance the
   * company is provisioned for the operator, so the name is the only prefix
   * source the operator ever chose — a rename re-derives it. Returns null when
   * the current prefix is already correct or when the suffix space is
   * exhausted.
   */
  async function resolveRenamedIssuePrefix(
    tx: CompanyTx,
    companyId: string,
    companyPatch: Partial<typeof companies.$inferInsert>,
  ): Promise<{ fromPrefix: string; toPrefix: string } | null> {
    // Only patch and environment facts gate the lock. Every comparison against
    // the company's own name or prefix happens below, under the lock.
    // An explicit prefix in the patch is the caller's decision; never override it.
    if (companyPatch.issuePrefix !== undefined) return null;
    const nextName = companyPatch.name;
    if (typeof nextName !== "string" || nextName.trim().length === 0) return null;
    if (!isCloudManagedInstance()) return null;

    // Lock the company row before comparing anything against it. Two concurrent
    // updates would otherwise each decide from the row they read before either
    // committed, and both ways of getting that wrong end with a company whose
    // prefix disagrees with its own identifiers:
    //
    //   - Two renames: the second re-keys from the prefix it read, finds the
    //     identifiers the first already moved, and leaves them on the first
    //     rename's prefix while the row carries the second one's.
    //   - A rename plus a stale form that resubmits the original name: the
    //     second sees a name equal to the one it read, skips re-derivation, and
    //     restores the old name on top of the first rename's prefix.
    //
    // Reading the row under the lock makes the second transaction decide from
    // what the first actually committed. Only a managed instance takes this
    // lock, and only for an update that carries a name.
    const locked = await tx
      .select({ name: companies.name, issuePrefix: companies.issuePrefix })
      .from(companies)
      .where(eq(companies.id, companyId))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!locked || nextName === locked.name) return null;

    const nextBase = deriveIssuePrefixBase(nextName);
    // A rename that keeps the same base keeps the current prefix, including
    // any disambiguating suffix it was allocated.
    if (nextBase === deriveIssuePrefixBase(locked.name)) return null;
    if (nextBase === locked.issuePrefix) return null;

    const candidate = await pickAvailableIssuePrefix(tx, nextBase);
    if (!candidate || candidate === locked.issuePrefix) return null;
    return { fromPrefix: locked.issuePrefix, toPrefix: candidate };
  }

  // Attempts for a prefix conflict the pre-select could not have seen. Small
  // on purpose: allocations that go through allocateIssuePrefix serialize on
  // its lock and never contend with each other here — what remains is
  // allocator-external writers (resolveCloudTenantActor inserts a company
  // with its own stack-derived prefix without taking the lock).
  const ISSUE_PREFIX_CONFLICT_ATTEMPTS = 3;

  /** Re-run a whole transaction when it loses the issue-prefix unique index.
   *
   * MUST wrap the transaction, never sit inside it: Postgres aborts the
   * transaction on a constraint violation, so a retry in place fails 25P02
   * ("current transaction is aborted") instead of trying the next suffix.
   */
  async function retryOnIssuePrefixConflict<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await run();
      } catch (error) {
        if (attempt >= ISSUE_PREFIX_CONFLICT_ATTEMPTS || !isIssuePrefixConflict(error)) throw error;
      }
    }
  }

  /** The single allocator BOTH the create and rename paths go through.
   *
   * Serializes on the derived base, the way nextCaseIdentity serializes case
   * numbering. Without one shared lock, concurrent allocators each pre-select
   * the same free candidate and all but one lose the unique index — and a
   * bounded retry cannot be relied on to converge, because every round can be
   * stolen again. Holding the lock, each allocation runs after the previous
   * one committed, sees that prefix as taken, and takes the next suffix.
   *
   * Transaction-scoped, so it releases at commit: every caller MUST be inside
   * a transaction, or the lock drops at statement end and buys nothing.
   *
   * ``excludeCompanyId`` is the row being renamed — its own current prefix
   * must not count as taken.
   */
  async function allocateIssuePrefix(
    tx: Pick<Db, "select" | "execute">,
    name: string,
    excludeCompanyId?: string,
  ) {
    const base = deriveIssuePrefixBase(name);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`paperclip:issue-prefix:${base}`}))`);
    const takenRows = await tx
      .select({ issuePrefix: companies.issuePrefix })
      .from(companies)
      .where(
        excludeCompanyId
          ? and(like(companies.issuePrefix, `${base}%`), ne(companies.id, excludeCompanyId))
          : like(companies.issuePrefix, `${base}%`),
      );
    const taken = new Set(takenRows.map((row) => row.issuePrefix));
    for (let attempt = 1; attempt < 10000; attempt += 1) {
      const candidate = `${base}${issuePrefixSuffixForAttempt(attempt)}`;
      if (!taken.has(candidate)) return candidate;
    }
    return null;
  }

  async function createCompanyWithUniquePrefix(data: typeof companies.$inferInsert) {
    // The insert runs inside a transaction so the allocator's advisory lock
    // holds until it commits — that is what stops a create from claiming the
    // prefix a concurrent rename already selected, and vice versa. The retry
    // wraps the transaction (see retryOnIssuePrefixConflict) because a
    // conflict aborts it.
    return retryOnIssuePrefixConflict(() =>
      db.transaction(async (tx) => {
        const allocated = await allocateIssuePrefix(tx, data.name);
        if (!allocated) throw new Error("Unable to allocate unique issue prefix");
        const rows = await tx
          .insert(companies)
          .values({ ...data, issuePrefix: allocated })
          .returning();
        return rows[0];
      }),
    );
  }

  return {
    list: async () => {
      const rows = await getCompanyQuery(db);
      const hydrated = await hydrateCompanySpend(rows);
      return hydrated.map((row) => enrichCompany(row));
    },

    getById: async (id: string) => {
      // Non-UUID refs previously reached the uuid-typed query and threw a
      // DrizzleQueryError ("invalid input syntax for type uuid"), surfacing
      // as HTTP 500 from GET /api/companies/:companyId. Treat them as
      // not-found so the route returns 404.
      if (!UUID_RE.test(id)) return null;
      const row = await getCompanyQuery(db)
        .where(eq(companies.id, id))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const [hydrated] = await hydrateCompanySpend([row], db);
      return enrichCompany(hydrated);
    },

    create: async (data: typeof companies.$inferInsert) => {
      const created = await createCompanyWithUniquePrefix(data);
      await environmentsSvc.ensureLocalEnvironment(created.id);
      await builtInAgents.autoProvisionBundledAgents(created.id);
      const row = await getCompanyQuery(db)
        .where(eq(companies.id, created.id))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Company not found after creation");
      const [hydrated] = await hydrateCompanySpend([row], db);
      return enrichCompany(hydrated);
    },

    update: async (
      id: string,
      data: Partial<typeof companies.$inferInsert> & { logoAssetId?: string | null },
      actor: CompanyActivityActor = SYSTEM_COMPANY_ACTOR,
    ) => {
      const runUpdateTx = () => db.transaction(async (tx) => {
        const existing = await getCompanyQuery(tx)
          .where(eq(companies.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        const { logoAssetId, ...companyPatch } = data;

        // Companies are created under a placeholder name and the issue prefix
        // freezes at insert. A rename that lands before anything has minted an
        // identifier (no issues, no cases) re-derives the prefix from the name
        // actually chosen; once identifiers exist the prefix is permanent.
        //
        // The emptiness check re-reads the counter under FOR UPDATE: issue
        // creation increments companies.issueCounter (taking this same row
        // lock), so a concurrent create either commits first — the re-read
        // sees a non-zero counter and the prefix stays — or blocks until this
        // rename commits and mints its identifier from the new prefix. The
        // pre-lock `existing` read is not trustworthy for this decision.
        if (
          companyPatch.issuePrefix === undefined &&
          typeof companyPatch.name === "string" &&
          companyPatch.name.trim() !== "" &&
          companyPatch.name !== existing.name
        ) {
          const [locked] = await tx
            .select({ issueCounter: companies.issueCounter, issuePrefix: companies.issuePrefix })
            .from(companies)
            .where(eq(companies.id, id))
            .for("update");
          if (locked?.issueCounter === 0) {
            const [existingCase] = await tx
              .select({ id: cases.id })
              .from(cases)
              .where(eq(cases.companyId, id))
              .limit(1);
            if (!existingCase) {
              const candidate = await allocateIssuePrefix(tx, companyPatch.name, id);
              if (candidate && candidate !== locked.issuePrefix) {
                companyPatch.issuePrefix = candidate;
              }
            }
          }
        }

        const willReactivate = existing.status !== "active" && companyPatch.status === "active";
        const willArchive = existing.status !== "archived" && companyPatch.status === "archived";

        if (logoAssetId !== undefined && logoAssetId !== null) {
          const nextLogoAsset = await tx
            .select({ id: assets.id, companyId: assets.companyId })
            .from(assets)
            .where(eq(assets.id, logoAssetId))
            .then((rows) => rows[0] ?? null);
          if (!nextLogoAsset) throw notFound("Logo asset not found");
          if (nextLogoAsset.companyId !== existing.id) {
            throw unprocessable("Logo asset must belong to the same company");
          }
        }

        const renamedPrefix = await resolveRenamedIssuePrefix(tx, id, companyPatch);

        const updated = await tx
          .update(companies)
          .set({
            ...companyPatch,
            ...(renamedPrefix ? { issuePrefix: renamedPrefix.toPrefix } : {}),
            updatedAt: new Date(),
          })
          .where(eq(companies.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) return null;

        let issuePrefixRederived: {
          previousIssuePrefix: string;
          issuePrefix: string;
          issuesRekeyed: number;
          casesRekeyed: number;
        } | null = null;
        if (renamedPrefix) {
          const rekeyed = await rekeyCompanyIssueIdentifiers(tx, {
            companyId: id,
            fromPrefix: renamedPrefix.fromPrefix,
            toPrefix: renamedPrefix.toPrefix,
          });
          issuePrefixRederived = {
            previousIssuePrefix: renamedPrefix.fromPrefix,
            issuePrefix: renamedPrefix.toPrefix,
            issuesRekeyed: rekeyed.issues,
            casesRekeyed: rekeyed.cases,
          };
        }

        let agentsRestored = 0;
        if (willReactivate) {
          const restoredRows = await tx
            .update(agents)
            .set({
              status: "idle",
              pauseReason: null,
              pausedAt: null,
              updatedAt: new Date(),
            })
            .where(and(
              eq(agents.companyId, id),
              eq(agents.status, "paused"),
              eq(agents.pauseReason, "company_archived"),
            ))
            .returning({ id: agents.id });
          agentsRestored = restoredRows.length;
        }

        const archiveCascade = willArchive ? await applyArchiveCascadeInTx(tx, id) : null;

        if (logoAssetId === null) {
          await tx.delete(companyLogos).where(eq(companyLogos.companyId, id));
        } else if (logoAssetId !== undefined) {
          await tx
            .insert(companyLogos)
            .values({
              companyId: id,
              assetId: logoAssetId,
            })
            .onConflictDoUpdate({
              target: companyLogos.companyId,
              set: {
                assetId: logoAssetId,
                updatedAt: new Date(),
              },
            });
        }

        if (logoAssetId !== undefined && existing.logoAssetId && existing.logoAssetId !== logoAssetId) {
          await tx.delete(assets).where(eq(assets.id, existing.logoAssetId));
        }

        const [hydrated] = await hydrateCompanySpend([{
          ...updated,
          logoAssetId: logoAssetId === undefined ? existing.logoAssetId : logoAssetId,
        }], tx);

        const shouldLogReactivation = willReactivate &&
          (existing.status === "archived" || agentsRestored > 0);

        return {
          company: enrichCompany(hydrated),
          reactivated: shouldLogReactivation ? { agentsRestored } : null,
          archiveCascade,
          issuePrefixRederived,
        };
      });
      // Create and rename both serialize on allocateIssuePrefix's per-base
      // advisory lock, so a candidate chosen under it cannot be claimed by
      // another allocation before this transaction commits. The retry covers
      // allocator-external writers only, and wraps the transaction because a
      // conflict aborts it (see retryOnIssuePrefixConflict).
      const result = await retryOnIssuePrefixConflict(runUpdateTx);
      if (!result) return null;
      if (result.issuePrefixRederived) {
        await logActivity(db, {
          companyId: id,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId ?? null,
          runId: actor.runId ?? null,
          action: "company.updated",
          entityType: "company",
          entityId: id,
          details: {
            source: "company_rename",
            reason: "issue_prefix_rederived",
            ...result.issuePrefixRederived,
          },
        });
      }
      if (result.reactivated) {
        await logActivity(db, {
          companyId: id,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId ?? null,
          runId: actor.runId ?? null,
          action: "company.reactivated",
          entityType: "company",
          entityId: id,
          details: { agentsRestored: result.reactivated.agentsRestored },
        });
      }
      if (result.archiveCascade) {
        await finalizeArchive(id, actor, result.archiveCascade);
      }
      return result.company;
    },

    archive: async (id: string, actor: CompanyActivityActor = SYSTEM_COMPANY_ACTOR) => {
      const result = await db.transaction(async (tx) => {
        const existing = await tx
          .select({ status: companies.status })
          .from(companies)
          .where(eq(companies.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        const wasAlreadyArchived = existing.status === "archived";

        if (!wasAlreadyArchived) {
          await tx
            .update(companies)
            .set({ status: "archived", updatedAt: new Date() })
            .where(eq(companies.id, id));
        }

        const cascade = wasAlreadyArchived ? null : await applyArchiveCascadeInTx(tx, id);

        const row = await getCompanyQuery(tx)
          .where(eq(companies.id, id))
          .then((rows) => rows[0] ?? null);
        if (!row) return null;
        const [hydrated] = await hydrateCompanySpend([row], tx);
        return {
          company: enrichCompany(hydrated),
          cascade,
        };
      });
      if (!result) return null;

      if (result.cascade) {
        await finalizeArchive(id, actor, result.cascade);
      }

      return result.company;
    },

    remove: (id: string) =>
      db.transaction(async (tx) => {
        // heartbeat_run_events rows can reference this company's runs while
        // carrying a different company_id, so clear them by run id before the
        // sequence below deletes heartbeat_runs.
        const companyRunIds = await tx
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.companyId, id));
        if (companyRunIds.length > 0) {
          await tx
            .delete(heartbeatRunEvents)
            .where(inArray(heartbeatRunEvents.runId, companyRunIds.map((run) => run.id)));
        }

        for (const table of COMPANY_DELETE_SEQUENCE) {
          await tx.delete(table).where(eq(table.companyId, id));
        }

        const rows = await tx
          .delete(companies)
          .where(eq(companies.id, id))
          .returning();
        return rows[0] ?? null;
      }),

    stats: () =>
      Promise.all([
        db
          .select({ companyId: agents.companyId, count: count() })
          .from(agents)
          .groupBy(agents.companyId),
        db
          .select({ companyId: issues.companyId, count: count() })
          .from(issues)
          .groupBy(issues.companyId),
      ]).then(([agentRows, issueRows]) => {
        const result: Record<string, { agentCount: number; issueCount: number }> = {};
        for (const row of agentRows) {
          result[row.companyId] = { agentCount: row.count, issueCount: 0 };
        }
        for (const row of issueRows) {
          if (result[row.companyId]) {
            result[row.companyId].issueCount = row.count;
          } else {
            result[row.companyId] = { agentCount: 0, issueCount: row.count };
          }
        }
        return result;
      }),
  };
}
