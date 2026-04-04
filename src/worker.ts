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
      try {
        const all = await ctx.issues.list({ companyId, assigneeAgentId: agentId } as Record<string, unknown>);
        return all.filter((i: Record<string, unknown>) =>
          i.status === "todo" || i.status === "in_progress"
        ).length;
      } catch {
        return 0;
      }
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

    // ── Helper: get assignee from issue ────────────────────────
    async function getIssueAssignee(issueId: string, companyId: string): Promise<string | null> {
      try {
        const issue = await ctx.issues.get(issueId, companyId);
        return (issue as Record<string, unknown>)?.assigneeAgentId as string ?? null;
      } catch {
        return null;
      }
    }

    // ══════════════════════════════════════════════════════════
    // EVENT: issue.created — invoke assigned agent immediately
    // ══════════════════════════════════════════════════════════
    ctx.events.on("issue.created", async (event: PluginEvent) => {
      if (!cfg.enabled) return;

      // Look up the issue to find the assignee (payload doesn't include it)
      const agentId = await getIssueAssignee(event.entityId, event.companyId);
      if (!agentId) return;

      // Store company ID for the job handler
      await ctx.state.set({ scopeKind: "instance", stateKey: "known-company-id" }, event.companyId).catch(() => {});

      const agentName = await getAgentName(agentId, event.companyId);
      ctx.logger.info("Issue created, invoking assignee", { agentId, agentName, issueId: event.entityId });
      await tryInvoke(agentId, event.companyId, agentName, "issue assigned");
    });

    // ══════════════════════════════════════════════════════════
    // EVENT: issue.updated — invoke if agent is assigned
    // ══════════════════════════════════════════════════════════
    ctx.events.on("issue.updated", async (event: PluginEvent) => {
      if (!cfg.enabled) return;

      const agentId = await getIssueAssignee(event.entityId, event.companyId);
      if (!agentId) return;

      // Store company ID for the job handler
      await ctx.state.set({ scopeKind: "instance", stateKey: "known-company-id" }, event.companyId).catch(() => {});

      const agentName = await getAgentName(agentId, event.companyId);
      await tryInvoke(agentId, event.companyId, agentName, "issue updated");
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

      // Iterate over all companies (supports multi-company setups)
      let companies: Array<{ id: string; name?: string }> = [];
      try {
        companies = await ctx.companies.list() as Array<{ id: string; name?: string }>;
      } catch (err) {
        ctx.logger.warn("Failed to list companies", { error: String(err) });
        return;
      }

      if (companies.length === 0) return;

      for (const company of companies) {
        const companyId = company.id;
        const state = await loadState(companyId);

        // Fire any due delayed re-invocations
        const due = getDueInvocations(state);
        for (const agentId of due) {
          clearPending(state, agentId);
          const agentName = await getAgentName(agentId, companyId);
          await tryInvoke(agentId, companyId, agentName, "backlog re-invoke");
        }

        // Scan agents with known backlog from previous events
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

        // Also check for agents with pending issues that aren't tracked yet
        // (bootstraps existing backlogs on first run)
        try {
          const agents = await ctx.agents.list({ companyId });
          for (const agent of agents) {
            if (agent.status === "paused") continue;
            if (state.agents[agent.id]) continue; // already tracked
            const backlog = await countBacklog(agent.id, companyId);
            if (backlog > 0) {
              await tryInvoke(agent.id, companyId, agent.name || agent.id, "initial backlog");
            }
          }
        } catch { /* agents.list may fail — that's ok, tracked agents still work */ }

        await saveState(companyId, state);
      }
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
