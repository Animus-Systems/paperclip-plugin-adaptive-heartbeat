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
    // EVENT: issue.comment.created — cross-agent @request trigger
    // ══════════════════════════════════════════════════════════
    ctx.events.on("issue.comment.created", async (event: PluginEvent) => {
      if (!cfg.enabled) return;

      const payload = event.payload as Record<string, unknown>;
      const body = (payload?.body ?? payload?.content ?? "") as string;

      // Check for @request(agent=<name>) pattern
      const requestMatch = body.match(/@request\(\s*agent\s*=\s*([^,)]+)/i);
      if (!requestMatch) return;

      const targetName = requestMatch[1].trim().toLowerCase();
      if (!targetName) return;

      // Find the target agent by name
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
          requestSnippet: body.substring(0, 100),
        });

        // Invoke the target agent with context about the request
        const state = await loadState(event.companyId);
        if (isInCooldown(state, target.id, cfg.cooldownSec)) {
          ctx.logger.debug("Skipping @request invoke (cooldown)", { agentId: target.id });
          return;
        }

        await ctx.agents.invoke(target.id, event.companyId, {
          prompt: `You have been requested via @request on an issue. Check your assigned issues and any recent comments for requests tagged to you.`,
          reason: "adaptive-heartbeat: cross_agent_request",
        });

        markInvoked(state, target.id, target.name || targetName, "cross_agent_request", 0);
        await saveState(event.companyId, state);

        await ctx.activity.log({
          companyId: event.companyId,
          message: `Adaptive Heartbeat: invoked ${target.name} via @request on issue`,
          entityType: "agent",
          entityId: target.id,
          metadata: { trigger: "cross_agent_request", issueId: event.entityId },
        });
      } catch (err) {
        ctx.logger.warn("Failed to process @request", { error: String(err) });
      }
    });

    // ══════════════════════════════════════════════════════════
    // EVENT: agent.run.finished — re-invoke if backlog + unblock ready parents
    // ══════════════════════════════════════════════════════════
    ctx.events.on("agent.run.finished", async (event: PluginEvent) => {
      if (!cfg.enabled) return;
      const payload = event.payload as Record<string, unknown>;
      const agentId = (payload?.agentId ?? "") as string;
      if (!agentId) return;

      // ── Check for blocked parents that are now ready for synthesis ──
      // When an agent completes a subtask, the parent may be ready to unblock
      try {
        const agentIssues = await ctx.issues.list({
          companyId: event.companyId,
          assigneeAgentId: agentId,
        } as Record<string, unknown>);

        // Find issues this agent just completed that have a parent
        for (const issue of agentIssues) {
          const iss = issue as Record<string, unknown>;
          if (iss.status !== "done") continue;
          const parentId = iss.parentId as string | undefined;
          if (!parentId) continue;

          // Check the parent
          try {
            const parent = await ctx.issues.get(parentId, event.companyId);
            if (!parent) continue;
            const p = parent as Record<string, unknown>;
            if (p.status !== "blocked") continue;

            // Check all siblings (children of parent)
            const siblings = await ctx.issues.list({
              companyId: event.companyId,
              parentId,
            } as Record<string, unknown>);
            const openSiblings = siblings.filter((s: Record<string, unknown>) =>
              s.status !== "done" && s.status !== "cancelled"
            );

            if (openSiblings.length === 0) {
              // All subtasks done — unblock parent and invoke its assignee
              await ctx.issues.update(parentId, { status: "todo" }, event.companyId);
              const parentAgentId = p.assigneeAgentId as string;
              if (parentAgentId) {
                const parentAgentName = await getAgentName(parentAgentId, event.companyId);
                ctx.logger.info("Unblocked parent issue, invoking for synthesis", {
                  parentId,
                  parentIdentifier: p.identifier,
                  parentAgent: parentAgentName,
                });
                await tryInvoke(parentAgentId, event.companyId, parentAgentName, "subtasks complete → synthesis");
              }
            }
          } catch { /* best effort */ }
        }
      } catch { /* best effort — don't block the re-invoke logic */ }

      // ── Schedule re-invoke if this agent has more work ──
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

        // Scan all agents for pending issues (catches untracked backlogs)
        try {
          const agents = await ctx.agents.list({ companyId });
          for (const agent of agents) {
            if (agent.status === "paused") continue;
            // Skip if recently invoked (use 3x cooldown for scan to avoid spam)
            if (isInCooldown(state, agent.id, cfg.cooldownSec * 3)) continue;
            const backlog = await countBacklog(agent.id, companyId);
            if (backlog > 0) {
              await tryInvoke(agent.id, companyId, agent.name || agent.id, "backlog scan");
            }
          }
        } catch { /* agents.list may fail — tracked agents still work via events */ }

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
