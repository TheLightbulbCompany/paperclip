import { describe, expect, it } from "vitest";
import type { IssueExecutionPolicy } from "@paperclipai/shared";
import { buildRoutineMutationPayload as buildCreatePayload } from "./Routines";
import { buildRoutineMutationPayload as buildEditPayload, routineReviewerAgentId } from "./RoutineDetail";

const workerAgentId = "11111111-1111-4111-8111-111111111111";
const reviewerAgentId = "22222222-2222-4222-8222-222222222222";
const approverUserId = "cto-user";

const createDraft = {
  title: "nightly sweep",
  description: " Sweep it ",
  projectId: "",
  folderId: null,
  assigneeAgentId: workerAgentId,
  reviewerAgentId: "",
  priority: "medium",
  concurrencyPolicy: "coalesce_if_active",
  catchUpPolicy: "skip_missed",
  variables: [],
};

const editDraft = {
  title: "nightly sweep",
  description: "Sweep it",
  projectId: "",
  assigneeAgentId: workerAgentId,
  reviewerAgentId: "",
  priority: "medium",
  concurrencyPolicy: "coalesce_if_active",
  catchUpPolicy: "skip_missed",
  activityGatePolicy: "always",
  activityGateScope: "company",
  variables: [],
  env: null,
};

function policyWith(stages: IssueExecutionPolicy["stages"]): IssueExecutionPolicy {
  return { mode: "normal", commentRequired: true, stages };
}

describe("routine create payload", () => {
  it("sends no policy when no reviewer is picked", () => {
    expect(buildCreatePayload(createDraft).executionPolicy).toBeNull();
  });

  it("builds a review stage for the picked reviewer", () => {
    const policy = buildCreatePayload({ ...createDraft, reviewerAgentId }).executionPolicy;
    expect(policy?.stages).toHaveLength(1);
    expect(policy?.stages[0]).toMatchObject({ type: "review", approvalsNeeded: 1 });
    expect(policy?.stages[0]?.participants[0]).toMatchObject({ type: "agent", agentId: reviewerAgentId });
  });

  it("does not leak reviewerAgentId into the request body", () => {
    expect(buildCreatePayload({ ...createDraft, reviewerAgentId })).not.toHaveProperty("reviewerAgentId");
  });
});

describe("routine edit payload", () => {
  it("clears the policy when the reviewer is removed", () => {
    const existing = policyWith([
      { id: "stage-1", type: "review", approvalsNeeded: 1, participants: [{ id: "p1", type: "agent", agentId: reviewerAgentId, userId: null }] },
    ]);
    expect(buildEditPayload(editDraft, existing).executionPolicy).toBeNull();
  });

  it("keeps an approval stage this form cannot edit", () => {
    const existing = policyWith([
      { id: "stage-2", type: "approval", approvalsNeeded: 1, participants: [{ id: "p2", type: "user", agentId: null, userId: approverUserId }] },
    ]);

    const policy = buildEditPayload({ ...editDraft, reviewerAgentId }, existing).executionPolicy;

    expect(policy?.stages.map((stage) => stage.type)).toEqual(["review", "approval"]);
    expect(policy?.stages[1]?.participants[0]).toMatchObject({ id: "p2", type: "user", userId: approverUserId });
  });

  it("preserves participant ids when the reviewer is unchanged", () => {
    const existing = policyWith([
      { id: "stage-1", type: "review", approvalsNeeded: 1, participants: [{ id: "p1", type: "agent", agentId: reviewerAgentId, userId: null }] },
    ]);

    const policy = buildEditPayload({ ...editDraft, reviewerAgentId }, existing).executionPolicy;

    expect(policy?.stages[0]?.id).toBe("stage-1");
    expect(policy?.stages[0]?.participants[0]?.id).toBe("p1");
  });
});

describe("routineReviewerAgentId", () => {
  it("reads the review stage agent back out of a stored policy", () => {
    const policy = policyWith([
      { id: "stage-1", type: "review", approvalsNeeded: 1, participants: [{ id: "p1", type: "agent", agentId: reviewerAgentId, userId: null }] },
    ]);
    expect(routineReviewerAgentId(policy)).toBe(reviewerAgentId);
  });

  it("returns an empty selection for a policy-less routine", () => {
    expect(routineReviewerAgentId(null)).toBe("");
    expect(routineReviewerAgentId(undefined)).toBe("");
  });

  it("returns an empty selection when only an approval stage exists", () => {
    const policy = policyWith([
      { id: "stage-2", type: "approval", approvalsNeeded: 1, participants: [{ id: "p2", type: "user", agentId: null, userId: approverUserId }] },
    ]);
    expect(routineReviewerAgentId(policy)).toBe("");
  });
});
