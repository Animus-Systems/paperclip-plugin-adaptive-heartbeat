import { definePlugin, startWorkerRpcHost } from "@paperclipai/plugin-sdk";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { AdaptiveConfig, SchedulerState } from "./worker/types.js";
import {
  stateKey,
  emptyState,
  isInCooldown,
  markInvoked,
  scheduleReinvoke,
  getDueInvocations,
  clearPending,
} from "./worker/scheduler.js";

const DEFAULT_CONFIG: AdaptiveConfig = {
  enabled: true,
  cooldownSec: 60,
  backlogDelaySec: 120,
  heavyBacklogDelaySec: 60,
};

const plugin = definePlugin({
  async setup(ctx) {
    const rawConfig = await ctx.config.get();
    const cfg: AdaptiveConfig = { ...DEFAULT_CONFIG, ...(rawConfig as Partial<AdaptiveConfig>) };

    ctx.logger.info("Adaptive Heartbeat plugin starting", {
      cooldownSec: cfg.cooldownSec,
      backlogDelaySec: cfg.backlogDelaySec,
      heavyBacklogDelaySec: cfg.heavyBacklogDelaySec,
    });

    // ── Helper: load/save state ──────────────────────────────
    async function loadState(companyId: string): Promise<SchedulerState> {
      return ((await ctx.state.get(stateKey(companyId))) ?? emptyState()) as SchedulerState;
    }
    async function saveState(companyId: string, state: SchedulerState): Promise<void> {
      await ctx.state.set(stateKey(companyId), state);
    }

    // ── Helper: count pending issues for an agent ────────────
    async function countBacklog(agentId: string, companyId: string): Promise<number> {
      const issues = await ctx.issues.list({
        companyId,
        assigneeAgentId: agentId,
        status: "todo" as unknown as undefined, // SDK type mismatch workaround
      });
      const inProgress = await ctx.issues.list({
        companyId,
        assigneeAgentId: agentId,
        status: "in_progress" as unknown as undefined,
      });
      return issues.length + inProgress.length;
    }

    // ── Helper: invoke an agent with debounce ────────────────
    async function tryInvoke(
      agentId: string,
      companyId: string,
      agentName: string,
      reason: string,
    ): Promise<boolean> {
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
          reason: `adaptive-heartbeat: ${reason}`,
        });

        markInvoked(state, agentId, agentName, reason, backlog);
        await saveState(companyId, state);

        await ctx.activity.log({
          companyId,
          message: `Adaptive Heartbeat: invoked ${agentName} (${reason}, ${backlog} pending)`,
          entityType: "agent",
          entityId: agentId,
        });

        ctx.logger.info("Invoked agent", { agentId, agentName, reason, backlog });
        return true;
      } catch (err) {
        ctx.logger.warn("Failed to invoke agent", { agentId, error: String(err) });
        return false;
      }
    }

    // ══════════════════════════════════════════════════════════
    // EVENT: issue.created — invoke assigned agent immediately
    // ══════════════════════════════════════════════════════════
    ctx.events.on("issue.created", async (event: PluginEvent) => {
      if (!cfg.enabled) return;
      const payload = event.payload as Record<string, unknown>;
      const agentId = (payload?.assigneeAgentId ?? payload?.agentId ?? "") as string;
      if (!agentId) return;

      const agentName = await getAgentName(agentId, event.companyId);
      await tryInvoke(agentId, event.companyId, agentName, "issue assigned");
    });

    // ══════════════════════════════════════════════════════════
    // EVENT: issue.updated — invoke if agent assignment changed
    // ══════════════════════════════════════════════════════════
    ctx.events.on("issue.updated", async (event: PluginEvent) => {
      if (!cfg.enabled) return;
      const payload = event.payload as Record<string, unknown>;
      const changes = payload?.changes as Record<string, unknown> | undefined;

      // Only react to assignment changes or status changes to todo
      const newAssignee = (changes?.assigneeAgentId ?? payload?.assigneeAgentId ?? "") as string;
      if (!newAssignee) return;

      // If reassigned, invoke the new assignee
      if (changes?.assigneeAgentId) {
        const agentName = await getAgentName(newAssignee, event.companyId);
        await tryInvoke(newAssignee, event.companyId, agentName, "issue reassigned");
      }
    });

    // ══════════════════════════════════════════════════════════
    // EVENT: agent.run.finished — schedule re-invoke if backlog
    // ══════════════════════════════════════════════════════════
    ctx.events.on("agent.run.finished", async (event: PluginEvent) => {
      if (!cfg.enabled) return;
      const payload = event.payload as Record<string, unknown>;
      const agentId = (payload?.agentId ?? "") as string;
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
        delaySec: backlog >= 3 ? cfg.heavyBacklogDelaySec : cfg.backlogDelaySec,
      });
    });

    // ── Helper: get agent name ───────────────────────────────
    async function getAgentName(agentId: string, companyId: string): Promise<string> {
      try {
        const agent = await ctx.agents.get(agentId, companyId);
        return agent?.name || agentId;
      } catch {
        return agentId;
      }
    }

    // ══════════════════════════════════════════════════════════
    // JOB: backlog-check — fire due invocations every 2 min
    // ══════════════════════════════════════════════════════════
    ctx.jobs.register("backlog-check", async () => {
      if (!cfg.enabled) return;

      // Discover company ID from recent state
      let companyId = "";
      try {
        const stored = await ctx.state.get({ scopeKind: "instance", stateKey: "known-company-id" });
        if (stored && typeof stored === "string") companyId = stored;
      } catch { /* fallback */ }

      if (!companyId) {
        // Try to find it from agents
        try {
          const agents = await ctx.agents.list({ limit: 1 } as Record<string, unknown>);
          if (agents.length > 0) {
            companyId = (agents[0] as Record<string, unknown>).companyId as string ||
                        (agents[0] as Record<string, unknown>).company_id as string || "";
          }
        } catch { /* no company context yet */ }
      }

      if (!companyId) return;

      // Store for future use
      await ctx.state.set({ scopeKind: "instance", stateKey: "known-company-id" }, companyId).catch(() => {});

      const state = await loadState(companyId);
      const due = getDueInvocations(state);

      for (const agentId of due) {
        clearPending(state, agentId);
        const agentName = await getAgentName(agentId, companyId);
        await tryInvoke(agentId, companyId, agentName, "backlog re-invoke");
      }

      // Also scan for agents with backlog that aren't scheduled
      try {
        const agents = await ctx.agents.list({ companyId });
        for (const agent of agents) {
          if (agent.status === "paused") continue;
          const agentState = state.agents[agent.id];

          // Skip if recently invoked or already has pending
          if (agentState?.pendingInvokeAt) continue;
          if (isInCooldown(state, agent.id, cfg.cooldownSec * 3)) continue; // 3x cooldown for scan

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

    // ══════════════════════════════════════════════════════════
    // DATA: dashboard widget data
    // ══════════════════════════════════════════════════════════
    ctx.data.register("adaptive:status", async (params: Record<string, unknown>) => {
      const companyId = params.companyId as string;
      const state = await loadState(companyId);

      // Count agents with backlog
      const agentsWithBacklog: Array<{ name: string; backlog: number; pending: boolean }> = [];
      for (const [agentId, agentState] of Object.entries(state.agents)) {
        if (agentState.lastBacklogCount > 0 || agentState.pendingInvokeAt) {
          const name = await getAgentName(agentId, companyId);
          agentsWithBacklog.push({
            name,
            backlog: agentState.lastBacklogCount,
            pending: !!agentState.pendingInvokeAt,
          });
        }
      }

      return {
        enabled: cfg.enabled,
        cooldownSec: cfg.cooldownSec,
        agentsWithBacklog: agentsWithBacklog.sort((a, b) => b.backlog - a.backlog),
        recentInvocations: state.recentInvocations.slice(0, 15),
        totalInvocations: state.recentInvocations.length,
      };
    });
  },

  async onHealth() {
    return { status: "ok" };
  },
});

export default plugin;
startWorkerRpcHost({ plugin });
