import { describe, expect, it } from "vitest";
import {
  AGENT_ROLE_LABELS,
  acceptInviteSchema,
  createAgentHireSchema,
  createAgentSchema,
  updateAgentSchema,
} from "./index.js";

describe("dynamic adapter type validation schemas", () => {
  it("accepts external adapter types in create/update agent schemas", () => {
    expect(
      createAgentSchema.parse({
        name: "External Agent",
        adapterType: "external_adapter",
      }).adapterType,
    ).toBe("external_adapter");

    expect(
      updateAgentSchema.parse({
        adapterType: "external_adapter",
      }).adapterType,
    ).toBe("external_adapter");
  });

  it("still rejects blank adapter types", () => {
    expect(() =>
      createAgentSchema.parse({
        name: "Blank Adapter",
        adapterType: "   ",
      }),
    ).toThrow();
    expect(() =>
      createAgentHireSchema.parse({
        name: "Pending Agent",
        adapterType: "process",
        idempotencyKey: "unsupported:hire",
      }),
    ).toThrow();
    expect(() =>
      createAgentHireSchema.parse({
        name: "Pending Agent",
        adapterType: "process",
        idempotencyReplayOnly: true,
      }),
    ).toThrow();
    expect(() => updateAgentSchema.parse({ idempotencyKey: "unsupported:patch" })).toThrow();
    expect(() => updateAgentSchema.parse({ idempotencyReplayOnly: true })).toThrow();
  });

  it("accepts an explicit managed instructions bundle for new agents", () => {
    expect(
      createAgentSchema.parse({
        name: "Bundle Agent",
        adapterType: "codex_local",
        instructionsBundle: {
          files: {
            "AGENTS.md": "Use AGENTS.md.",
          },
        },
      }).instructionsBundle?.files["AGENTS.md"],
    ).toBe("Use AGENTS.md.");
  });

  it("rejects body aliases for the agent-create idempotency headers", () => {
    expect(() =>
      createAgentSchema.parse({
        name: "Idempotent Agent",
        adapterType: "process",
        idempotencyKey: "hire:agent:v1",
      }),
    ).toThrow();
    expect(() =>
      createAgentSchema.parse({
        name: "Replay Agent",
        adapterType: "process",
        idempotencyReplayOnly: true,
      }),
    ).toThrow();
  });

  it("accepts external adapter types in invite acceptance schema", () => {
    expect(
      acceptInviteSchema.parse({
        requestType: "agent",
        agentName: "External Joiner",
        adapterType: "external_adapter",
      }).adapterType,
    ).toBe("external_adapter");
  });

  it("accepts the security agent role and exposes its UI label", () => {
    expect(
      createAgentSchema.parse({
        name: "Security Engineer",
        role: "security",
        adapterType: "codex_local",
      }).role,
    ).toBe("security");

    expect(AGENT_ROLE_LABELS.security).toBe("Security");
  });
});
