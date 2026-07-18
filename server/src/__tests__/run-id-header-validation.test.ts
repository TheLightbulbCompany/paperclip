import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { actorMiddleware, RUN_ID_HEADER_ERROR_MESSAGE } from "../middleware/auth.js";

/**
 * Agents fabricate X-Paperclip-Run-Id values (e.g. "startup-kickoff-<epoch>")
 * when they are not executing inside a heartbeat run. The raw header used to
 * be stamped onto req.actor.runId unvalidated, and downstream heartbeat_runs
 * lookups keyed on it failed inside Postgres uuid casts, surfacing as opaque
 * 500s. The middleware must reject non-UUID values with a self-explanatory
 * 400 before any actor path stamps them.
 */

function createSelectChain(rows: unknown[]) {
  return {
    from() {
      return {
        where() {
          return Promise.resolve(rows);
        },
      };
    },
  };
}

function createDb() {
  return {
    select: vi.fn().mockImplementation(() => createSelectChain([])),
  } as any;
}

function buildApp(deploymentMode: "authenticated" | "local_trusted") {
  const app = express();
  app.use(
    actorMiddleware(createDb(), {
      deploymentMode,
      resolveSession:
        deploymentMode === "authenticated"
          ? async () => ({
              session: { id: "session-1", userId: "user-1" },
              user: {
                id: "user-1",
                name: "User One",
                email: "user@example.com",
              },
            })
          : undefined,
    }),
  );
  app.get("/actor", (req, res) => {
    res.json(req.actor);
  });
  return app;
}

describe("X-Paperclip-Run-Id header validation", () => {
  it("rejects a fabricated non-UUID run id with a self-explanatory 400", async () => {
    const app = buildApp("authenticated");

    const res = await request(app)
      .get("/actor")
      .set("X-Paperclip-Run-Id", "startup-kickoff-1784092957");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: RUN_ID_HEADER_ERROR_MESSAGE });
  });

  it("rejects an empty run id header", async () => {
    const app = buildApp("authenticated");

    const res = await request(app).get("/actor").set("X-Paperclip-Run-Id", "");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: RUN_ID_HEADER_ERROR_MESSAGE });
  });

  it("accepts a canonical UUID and stamps it on the session actor", async () => {
    const app = buildApp("authenticated");
    const runId = "0b8f4a3e-9d27-4b64-8f0d-2f5a1c9e7d33";

    const res = await request(app).get("/actor").set("X-Paperclip-Run-Id", runId);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "board",
      userId: "user-1",
      source: "session",
      runId,
    });
  });

  it("treats an absent header as valid with no runId", async () => {
    const app = buildApp("authenticated");

    const res = await request(app).get("/actor");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: "board", userId: "user-1", source: "session" });
    expect(res.body.runId).toBeUndefined();
  });

  it("guards the local_trusted fallback stamping path too", async () => {
    const app = buildApp("local_trusted");

    const invalid = await request(app)
      .get("/actor")
      .set("X-Paperclip-Run-Id", "not-a-uuid");
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({ error: RUN_ID_HEADER_ERROR_MESSAGE });

    const runId = "7f6e5d4c-3b2a-4190-8877-665544332211";
    const valid = await request(app).get("/actor").set("X-Paperclip-Run-Id", runId);
    expect(valid.status).toBe(200);
    expect(valid.body).toMatchObject({ type: "board", source: "local_implicit", runId });
  });
});
