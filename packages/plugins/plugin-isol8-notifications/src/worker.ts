import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginEvent } from "@paperclipai/plugin-sdk";

/**
 * Forward the events that mean "a human is needed" to the Isol8 backend:
 * thread interactions (a paused issue), approvals, and run lifecycle.
 *
 * Deliberately dumb: no filtering beyond the subscription list, no retries,
 * no buffering — the backend decides what becomes a notification, and event
 * delivery here is fire-and-forget by design (host-side `notify` drops events
 * while the worker is restarting; Isol8 accepts that loss profile).
 *
 * Config comes from the worker environment (PAPERCLIP_ISOL8_NOTIFY_URL /
 * _TOKEN, passed through by buildPluginWorkerEnv for this plugin id only,
 * set on the ECS task by Isol8's paperclip-stack). Plugin configJson is
 * per-(pluginId, companyId) on this line and this worker serves every
 * company, so env is the only instance-wide channel. Unconfigured
 * instances (local dev) stay silent.
 *
 * `approval.decided` is intentionally not subscribed — the deciding human
 * doesn't need a push about their own decision.
 *
 * `issue.thread_interaction_created` is the one that actually fires: it is
 * emitted whenever an agent stops and asks a human to confirm, verify, answer,
 * or triage, and the issue stays parked until they do. Isol8 production logged
 * 27 of these — and zero approvals — before anything forwarded them.
 */
const FORWARDED_EVENTS = [
  "issue.thread_interaction_created",
  "approval.created",
  "approval.resubmitted",
  "agent.run.finished",
  "agent.run.failed",
] as const;

const plugin = definePlugin({
  async setup(ctx) {
    const backendUrl = process.env["PAPERCLIP_ISOL8_NOTIFY_URL"] ?? "";
    const bearerToken = process.env["PAPERCLIP_ISOL8_NOTIFY_TOKEN"] ?? "";
    if (!backendUrl || !bearerToken) {
      ctx.logger.info("isol8-notifications: not configured; forwarding disabled");
      return;
    }
    const forward = async (event: PluginEvent): Promise<void> => {
      try {
        const response = await ctx.http.fetch(backendUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${bearerToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(event),
        });
        if (!response.ok) {
          ctx.logger.warn(
            `isol8-notifications: backend responded ${response.status} for ${event.eventType} ${event.eventId}`,
          );
        }
      } catch (err) {
        ctx.logger.warn(
          `isol8-notifications: forward failed for ${event.eventType} ${event.eventId}: ${String(err)}`,
        );
      }
    };
    for (const eventType of FORWARDED_EVENTS) {
      ctx.events.on(eventType, forward);
    }
    ctx.logger.info("isol8-notifications: forwarding " + FORWARDED_EVENTS.join(", "));
  },

  async onHealth() {
    return { status: "ok", message: "isol8-notifications forwarder ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
