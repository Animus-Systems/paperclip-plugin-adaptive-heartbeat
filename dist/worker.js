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
      try {
        const all = await ctx.issues.list({ companyId, assigneeAgentId: agentId });
        return all.filter(
          (i) => i.status === "todo" || i.status === "in_progress"
        ).length;
      } catch {
        return 0;
      }
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
    async function getIssueAssignee(issueId, companyId) {
      try {
        const issue = await ctx.issues.get(issueId, companyId);
        return issue?.assigneeAgentId ?? null;
      } catch {
        return null;
      }
    }
    ctx.events.on("issue.created", async (event) => {
      if (!cfg.enabled) return;
      const agentId = await getIssueAssignee(event.entityId, event.companyId);
      if (!agentId) return;
      await ctx.state.set({ scopeKind: "instance", stateKey: "known-company-id" }, event.companyId).catch(() => {
      });
      const agentName = await getAgentName(agentId, event.companyId);
      ctx.logger.info("Issue created, invoking assignee", { agentId, agentName, issueId: event.entityId });
      await tryInvoke(agentId, event.companyId, agentName, "issue assigned");
    });
    ctx.events.on("issue.updated", async (event) => {
      if (!cfg.enabled) return;
      const agentId = await getIssueAssignee(event.entityId, event.companyId);
      if (!agentId) return;
      await ctx.state.set({ scopeKind: "instance", stateKey: "known-company-id" }, event.companyId).catch(() => {
      });
      const agentName = await getAgentName(agentId, event.companyId);
      await tryInvoke(agentId, event.companyId, agentName, "issue updated");
    });
    ctx.events.on("issue.comment.created", async (event) => {
      if (!cfg.enabled) return;
      const payload = event.payload;
      const body = payload?.body ?? payload?.content ?? payload?.bodySnippet ?? "";
      const requestMatch = body.match(/@request\(\s*agent\s*=\s*([^,)]+)/i);
      if (!requestMatch) return;
      const targetName = requestMatch[1].trim().toLowerCase();
      if (!targetName) return;
      try {
        const agents = await ctx.agents.list({ companyId: event.companyId });
        const target = agents.find((a) => (a.name || "").toLowerCase() === targetName);
        if (!target) {
          ctx.logger.debug("@request target agent not found", { targetName });
          return;
        }
        ctx.logger.info("Cross-agent @request detected", {
          targetAgent: target.name,
          issueId: event.entityId,
          requestSnippet: body.substring(0, 100)
        });
        const state = await loadState(event.companyId);
        if (isInCooldown(state, target.id, cfg.cooldownSec)) {
          ctx.logger.debug("Skipping @request invoke (cooldown)", { agentId: target.id });
          return;
        }
        await ctx.agents.invoke(target.id, event.companyId, {
          prompt: `You have been requested via @request on an issue. Check your assigned issues and any recent comments for requests tagged to you.`,
          reason: "adaptive-heartbeat: cross_agent_request"
        });
        markInvoked(state, target.id, target.name || targetName, "cross_agent_request", 0);
        await saveState(event.companyId, state);
        await ctx.activity.log({
          companyId: event.companyId,
          message: `Adaptive Heartbeat: invoked ${target.name} via @request on issue`,
          entityType: "agent",
          entityId: target.id,
          metadata: { trigger: "cross_agent_request", issueId: event.entityId }
        });
      } catch (err) {
        ctx.logger.warn("Failed to process @request", { error: String(err) });
      }
    });
    ctx.events.on("agent.run.finished", async (event) => {
      if (!cfg.enabled) return;
      const payload = event.payload;
      const agentId = payload?.agentId ?? "";
      if (!agentId) return;
      try {
        const agentIssues = await ctx.issues.list({
          companyId: event.companyId,
          assigneeAgentId: agentId
        });
        for (const issue of agentIssues) {
          const iss = issue;
          if (iss.status !== "done") continue;
          const parentId = iss.parentId;
          if (!parentId) continue;
          try {
            const parent = await ctx.issues.get(parentId, event.companyId);
            if (!parent) continue;
            const p = parent;
            if (p.status !== "blocked" && p.status !== "in_progress") continue;
            const siblings = await ctx.issues.list({
              companyId: event.companyId,
              parentId
            });
            const openSiblings = siblings.filter(
              (s) => s.status !== "done" && s.status !== "cancelled"
            );
            if (openSiblings.length === 0) {
              await ctx.issues.update(parentId, { status: "todo" }, event.companyId);
              const parentAgentId = p.assigneeAgentId;
              if (parentAgentId) {
                const parentAgentName = await getAgentName(parentAgentId, event.companyId);
                ctx.logger.info("Unblocked parent issue, invoking for synthesis", {
                  parentId,
                  parentIdentifier: p.identifier,
                  parentAgent: parentAgentName
                });
                await tryInvoke(parentAgentId, event.companyId, parentAgentName, "subtasks complete \u2192 synthesis");
              }
            }
          } catch {
          }
        }
      } catch {
      }
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
      let companies = [];
      try {
        companies = await ctx.companies.list();
      } catch {
      }
      if (companies.length === 0) {
        try {
          const stored = await ctx.state.get({ scopeKind: "instance", stateKey: "known-company-id" });
          if (typeof stored === "string" && stored.length > 10) {
            companies = [{ id: stored }];
          }
        } catch {
        }
      }
      if (companies.length === 0) {
        try {
          const memoryPlugin = await ctx.state.get({ scopeKind: "instance", stateKey: "known-company-id" });
          ctx.logger.warn("Backlog check: no companies found", { storedCompanyId: memoryPlugin, type: typeof memoryPlugin });
        } catch {
        }
        return;
      }
      ctx.logger.info("Backlog check starting", { companies: companies.length });
      for (const company of companies) {
        const companyId = company.id;
        const state = await loadState(companyId);
        const due = getDueInvocations(state);
        for (const agentId of due) {
          clearPending(state, agentId);
          const agentName = await getAgentName(agentId, companyId);
          await tryInvoke(agentId, companyId, agentName, "backlog re-invoke");
        }
        for (const [agentId, agentState] of Object.entries(state.agents)) {
          if (agentState.lastBacklogCount > 0 && !agentState.pendingInvokeAt) {
            if (isInCooldown(state, agentId, cfg.cooldownSec * 3)) continue;
            const agentName = await getAgentName(agentId, companyId);
            const currentBacklog = await countBacklog(agentId, companyId);
            if (currentBacklog > 0) {
              await tryInvoke(agentId, companyId, agentName, "backlog scan");
            } else {
              agentState.lastBacklogCount = 0;
            }
          }
        }
        try {
          const agents = await ctx.agents.list({ companyId });
          ctx.logger.info("Backlog scan: checking agents", { companyId, agentCount: agents.length });
          for (const agent of agents) {
            if (agent.status === "paused") continue;
            if (isInCooldown(state, agent.id, cfg.cooldownSec * 3)) continue;
            const backlog = await countBacklog(agent.id, companyId);
            if (backlog > 0) {
              await tryInvoke(agent.id, companyId, agent.name || agent.id, "backlog scan");
            }
          }
        } catch {
        }
        await saveState(companyId, state);
      }
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
