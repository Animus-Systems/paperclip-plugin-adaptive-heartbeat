// src/worker.ts
import { definePlugin, startWorkerRpcHost } from "@paperclipai/plugin-sdk";

// src/worker/scheduler.ts
var MAX_RECENT_INVOCATIONS = 50;
function stateKey(companyId) {
  return { scopeKind: "company", scopeId: companyId, stateKey: "scheduler-state" };
}
function emptyState() {
  return { agents: {}, recentInvocations: [] };
}
function getAgent(state, agentId) {
  if (!state.agents[agentId]) {
    state.agents[agentId] = { lastInvokeAt: null, pendingInvokeAt: null, lastBacklogCount: 0 };
  }
  return state.agents[agentId];
}
function isInCooldown(state, agentId, cooldownSec) {
  const agent = getAgent(state, agentId);
  if (!agent.lastInvokeAt) return false;
  const elapsed = (Date.now() - new Date(agent.lastInvokeAt).getTime()) / 1e3;
  return elapsed < cooldownSec;
}
function markInvoked(state, agentId, agentName, reason, backlogCount) {
  const agent = getAgent(state, agentId);
  agent.lastInvokeAt = (/* @__PURE__ */ new Date()).toISOString();
  agent.pendingInvokeAt = null;
  agent.lastBacklogCount = backlogCount;
  state.recentInvocations.unshift({
    agentId,
    agentName,
    reason,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    backlogCount
  });
  if (state.recentInvocations.length > MAX_RECENT_INVOCATIONS) {
    state.recentInvocations = state.recentInvocations.slice(0, MAX_RECENT_INVOCATIONS);
  }
}
function scheduleReinvoke(state, agentId, backlogCount, cfg) {
  const agent = getAgent(state, agentId);
  const delaySec = backlogCount >= 3 ? cfg.heavyBacklogDelaySec : cfg.backlogDelaySec;
  agent.pendingInvokeAt = new Date(Date.now() + delaySec * 1e3).toISOString();
  agent.lastBacklogCount = backlogCount;
}
function getDueInvocations(state) {
  const now = Date.now();
  const due = [];
  for (const [agentId, agent] of Object.entries(state.agents)) {
    if (agent.pendingInvokeAt && new Date(agent.pendingInvokeAt).getTime() <= now) {
      due.push(agentId);
    }
  }
  return due;
}
function clearPending(state, agentId) {
  const agent = getAgent(state, agentId);
  agent.pendingInvokeAt = null;
}

// src/worker.ts
var DEFAULT_CONFIG = {
  enabled: true,
  cooldownSec: 60,
  backlogDelaySec: 120,
  heavyBacklogDelaySec: 60
};
var plugin = definePlugin({
  async setup(ctx) {
    const rawConfig = await ctx.config.get();
    const cfg = { ...DEFAULT_CONFIG, ...rawConfig };
    ctx.logger.info("Adaptive Heartbeat plugin starting", {
      cooldownSec: cfg.cooldownSec,
      backlogDelaySec: cfg.backlogDelaySec,
      heavyBacklogDelaySec: cfg.heavyBacklogDelaySec
    });
    async function loadState(companyId) {
      return await ctx.state.get(stateKey(companyId)) ?? emptyState();
    }
    async function saveState(companyId, state) {
      await ctx.state.set(stateKey(companyId), state);
    }
    async function countBacklog(agentId, companyId) {
      const issues = await ctx.issues.list({
        companyId,
        assigneeAgentId: agentId,
        status: "todo"
        // SDK type mismatch workaround
      });
      const inProgress = await ctx.issues.list({
        companyId,
        assigneeAgentId: agentId,
        status: "in_progress"
      });
      return issues.length + inProgress.length;
    }
    async function tryInvoke(agentId, companyId, agentName, reason) {
      if (!cfg.enabled) return false;
      const state = await loadState(companyId);
      if (isInCooldown(state, agentId, cfg.cooldownSec)) {
        ctx.logger.debug("Skipping invoke (cooldown)", { agentId, agentName });
        return false;
      }
      try {
        const agent = await ctx.agents.get(agentId, companyId);
        if (!agent || agent.status === "paused") {
          ctx.logger.debug("Skipping invoke (agent paused or not found)", { agentId });
          return false;
        }
        const backlog = await countBacklog(agentId, companyId);
        if (backlog === 0) {
          ctx.logger.debug("Skipping invoke (no backlog)", { agentId, agentName });
          return false;
        }
        await ctx.agents.invoke(agentId, companyId, {
          prompt: `You have ${backlog} pending issue(s). Pick the highest priority one and work on it.`,
          reason: `adaptive-heartbeat: ${reason}`
        });
        markInvoked(state, agentId, agentName, reason, backlog);
        await saveState(companyId, state);
        await ctx.activity.log({
          companyId,
          message: `Adaptive Heartbeat: invoked ${agentName} (${reason}, ${backlog} pending)`,
          entityType: "agent",
          entityId: agentId
        });
        ctx.logger.info("Invoked agent", { agentId, agentName, reason, backlog });
        return true;
      } catch (err) {
        ctx.logger.warn("Failed to invoke agent", { agentId, error: String(err) });
        return false;
      }
    }
    ctx.events.on("issue.created", async (event) => {
      if (!cfg.enabled) return;
      const payload = event.payload;
      const agentId = payload?.assigneeAgentId ?? payload?.agentId ?? "";
      if (!agentId) return;
      const agentName = await getAgentName(agentId, event.companyId);
      await tryInvoke(agentId, event.companyId, agentName, "issue assigned");
    });
    ctx.events.on("issue.updated", async (event) => {
      if (!cfg.enabled) return;
      const payload = event.payload;
      const changes = payload?.changes;
      const newAssignee = changes?.assigneeAgentId ?? payload?.assigneeAgentId ?? "";
      if (!newAssignee) return;
      if (changes?.assigneeAgentId) {
        const agentName = await getAgentName(newAssignee, event.companyId);
        await tryInvoke(newAssignee, event.companyId, agentName, "issue reassigned");
      }
    });
    ctx.events.on("agent.run.finished", async (event) => {
      if (!cfg.enabled) return;
      const payload = event.payload;
      const agentId = payload?.agentId ?? "";
      if (!agentId) return;
      const backlog = await countBacklog(agentId, event.companyId);
      if (backlog === 0) return;
      const state = await loadState(event.companyId);
      scheduleReinvoke(state, agentId, backlog, cfg);
      await saveState(event.companyId, state);
      const agentName = await getAgentName(agentId, event.companyId);
      ctx.logger.info("Scheduled re-invoke", {
        agentId,
        agentName,
        backlog,
        delaySec: backlog >= 3 ? cfg.heavyBacklogDelaySec : cfg.backlogDelaySec
      });
    });
    async function getAgentName(agentId, companyId) {
      try {
        const agent = await ctx.agents.get(agentId, companyId);
        return agent?.name || agentId;
      } catch {
        return agentId;
      }
    }
    ctx.jobs.register("backlog-check", async () => {
      if (!cfg.enabled) return;
      let companyId = "";
      try {
        const stored = await ctx.state.get({ scopeKind: "instance", stateKey: "known-company-id" });
        if (stored && typeof stored === "string") companyId = stored;
      } catch {
      }
      if (!companyId) {
        try {
          const agents = await ctx.agents.list({ limit: 1 });
          if (agents.length > 0) {
            companyId = agents[0].companyId || agents[0].company_id || "";
          }
        } catch {
        }
      }
      if (!companyId) return;
      await ctx.state.set({ scopeKind: "instance", stateKey: "known-company-id" }, companyId).catch(() => {
      });
      const state = await loadState(companyId);
      const due = getDueInvocations(state);
      for (const agentId of due) {
        clearPending(state, agentId);
        const agentName = await getAgentName(agentId, companyId);
        await tryInvoke(agentId, companyId, agentName, "backlog re-invoke");
      }
      try {
        const agents = await ctx.agents.list({ companyId });
        for (const agent of agents) {
          if (agent.status === "paused") continue;
          const agentState = state.agents[agent.id];
          if (agentState?.pendingInvokeAt) continue;
          if (isInCooldown(state, agent.id, cfg.cooldownSec * 3)) continue;
          const backlog = await countBacklog(agent.id, companyId);
          if (backlog > 0) {
            await tryInvoke(agent.id, companyId, agent.name || agent.id, "backlog scan");
          }
        }
      } catch (err) {
        ctx.logger.warn("Backlog scan failed", { error: String(err) });
      }
      await saveState(companyId, state);
    });
    ctx.data.register("adaptive:status", async (params) => {
      const companyId = params.companyId;
      const state = await loadState(companyId);
      const agentsWithBacklog = [];
      for (const [agentId, agentState] of Object.entries(state.agents)) {
        if (agentState.lastBacklogCount > 0 || agentState.pendingInvokeAt) {
          const name = await getAgentName(agentId, companyId);
          agentsWithBacklog.push({
            name,
            backlog: agentState.lastBacklogCount,
            pending: !!agentState.pendingInvokeAt
          });
        }
      }
      return {
        enabled: cfg.enabled,
        cooldownSec: cfg.cooldownSec,
        agentsWithBacklog: agentsWithBacklog.sort((a, b) => b.backlog - a.backlog),
        recentInvocations: state.recentInvocations.slice(0, 15),
        totalInvocations: state.recentInvocations.length
      };
    });
  },
  async onHealth() {
    return { status: "ok" };
  }
});
var worker_default = plugin;
startWorkerRpcHost({ plugin });
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
