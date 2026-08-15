import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOW_TRUST_REVIEW_PRESET,
  LOW_TRUST_REVIEW_PRESET_VERSION,
  LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION,
  issueExecutionPolicySchema,
} from "@paperclipai/shared";
import type { IssueExecutionPolicy } from "@paperclipai/shared";
import { buildExecutionPolicy } from "./issue-execution-policy";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("buildExecutionPolicy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("generates schema-valid UUIDs when crypto.randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        for (let index = 0; index < bytes.length; index += 1) {
          bytes[index] = index;
        }
        return bytes;
      },
    });

    const policy = buildExecutionPolicy({
      existingPolicy: null,
      reviewerValues: [`agent:${AGENT_ID}`],
      approverValues: ["user:local-board"],
    });

    expect(policy).not.toBeNull();
    expect(issueExecutionPolicySchema.safeParse(policy).success).toBe(true);
    expect(policy?.stages).toHaveLength(2);

    for (const stage of policy?.stages ?? []) {
      expect(stage.id).toMatch(UUID_PATTERN);
      expect(stage.participants).toHaveLength(1);
      expect(stage.participants[0]?.id).toMatch(UUID_PATTERN);
    }
  });
});

describe("buildExecutionPolicy advanced-field preservation", () => {
  const REVIEWER_B = "00000000-0000-4000-8000-000000000002";
  const reviewPreset = {
    id: LOW_TRUST_REVIEW_PRESET,
    version: LOW_TRUST_REVIEW_PRESET_VERSION,
    rawOutputDisposition: LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION,
  } as const;
  const authorizationPolicy = { assignmentPolicy: { mode: "protected" as const } };

  function existingPolicy(): IssueExecutionPolicy {
    return {
      mode: "normal",
      commentRequired: true,
      stages: [
        {
          id: "00000000-0000-4000-8000-0000000000a1",
          type: "review",
          approvalsNeeded: 1,
          participants: [
            { id: "00000000-0000-4000-8000-0000000000b1", type: "agent", agentId: AGENT_ID, userId: null },
          ],
        },
      ],
      reviewPreset,
      authorizationPolicy,
      maxReviewRounds: 7,
    };
  }

  // No form calling this has a control for these fields, so a reviewer edit
  // must carry them rather than rebuild the policy without them and silently
  // weaken governance set through the API.
  it("carries reviewPreset, authorizationPolicy and maxReviewRounds when the reviewer changes", () => {
    const policy = buildExecutionPolicy({
      existingPolicy: existingPolicy(),
      reviewerValues: [`agent:${REVIEWER_B}`],
      approverValues: [],
    });

    expect(policy?.stages[0]?.participants[0]?.agentId).toBe(REVIEWER_B);
    expect(policy?.reviewPreset).toEqual(reviewPreset);
    expect(policy?.authorizationPolicy).toEqual(authorizationPolicy);
    expect(policy?.maxReviewRounds).toBe(7);
    expect(issueExecutionPolicySchema.safeParse(policy).success).toBe(true);
  });

  it("keeps them even when the last stage is removed", () => {
    const policy = buildExecutionPolicy({
      existingPolicy: existingPolicy(),
      reviewerValues: [],
      approverValues: [],
    });

    expect(policy).not.toBeNull();
    expect(policy?.stages).toEqual([]);
    expect(policy?.reviewPreset).toEqual(reviewPreset);
    expect(policy?.authorizationPolicy).toEqual(authorizationPolicy);
  });

  it("still returns null when there is nothing to preserve", () => {
    expect(buildExecutionPolicy({ existingPolicy: null, reviewerValues: [], approverValues: [] })).toBeNull();
  });
});
