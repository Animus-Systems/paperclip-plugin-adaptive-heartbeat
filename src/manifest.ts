import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "animusystems.adaptive-heartbeat",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Adaptive Heartbeat",
  description:
    "Event-driven agent scheduling — invokes agents immediately on issue assignment, scales run frequency by backlog depth.",
  author: "Animus Systems",
  categories: ["automation"],

  capabilities: [
    "events.subscribe",
    "companies.read",
    "agents.read",
    "agents.invoke",
    "issues.read",
    "plugin.state.read",
    "plugin.state.write",
    "activity.log.write",
    "jobs.schedule",
    "ui.dashboardWidget.register",
  ],

  instanceConfigSchema: {
    type: "object",
    properties: {
      enabled: {
        type: "boolean",
        title: "Enable Adaptive Scheduling",
        default: true,
      },
      cooldownSec: {
        type: "number",
        title: "Cooldown (seconds)",
        description: "Minimum seconds between invocations for the same agent",
        default: 60,
      },
      backlogDelaySec: {
        type: "number",
        title: "Backlog Delay (seconds)",
        description: "Delay before re-invoking an agent with 1-2 pending issues",
        default: 120,
      },
      heavyBacklogDelaySec: {
        type: "number",
        title: "Heavy Backlog Delay (seconds)",
        description: "Delay before re-invoking an agent with 3+ pending issues",
        default: 60,
      },
    },
  },

  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },

  jobs: [
    {
      jobKey: "backlog-check",
      displayName: "Backlog Check",
      description:
        "Scans agents for pending issues and fires due invocations. Catches missed events and handles delayed re-invocations.",
      schedule: "*/2 * * * *",
    },
  ],

  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "adaptive-heartbeat-status",
        displayName: "Adaptive Heartbeat",
        exportName: "AdaptiveHeartbeatWidget",
      },
    ],
  },
};

export default manifest;
