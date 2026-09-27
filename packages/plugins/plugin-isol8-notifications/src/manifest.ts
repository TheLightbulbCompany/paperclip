import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

/**
 * Stable plugin ID used by host registration and namespacing. The Isol8
 * backend addresses this plugin's config as /api/plugins/isol8.notifications.
 */
const PLUGIN_ID = "isol8.notifications";
const PLUGIN_VERSION = "0.1.0";

/**
 * Headless connector: no UI slots, no jobs, no tools. Subscribes to approval
 * and run-lifecycle domain events and forwards them to the Isol8 backend
 * (which decides what becomes a push notification).
 */
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Isol8 Notifications",
  description:
    "Forwards approval and agent-run lifecycle events to the Isol8 backend for push notifications.",
  author: "Isol8",
  categories: ["connector"],
  capabilities: ["events.subscribe", "http.outbound"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  // No instanceConfigSchema: plugin configJson is per-(pluginId, companyId)
  // on this line, and this worker serves every company — its receiver URL +
  // bearer token arrive via the worker env passthrough in
  // buildPluginWorkerEnv instead.
};

export default manifest;
