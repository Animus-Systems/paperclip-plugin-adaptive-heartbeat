import type { ScopeKey } from "@paperclipai/plugin-sdk";
import type { SchedulerState, AgentScheduleState, InvocationRecord, AdaptiveConfig } from "./types.js";

const MAX_RECENT_INVOCATIONS = 50;

export function stateKey(companyId: string): ScopeKey {
  return { scopeKind: "company", scopeId: companyId, stateKey: "scheduler-state" };
}

export function emptyState(): SchedulerState {
  return { agents: {}, recentInvocations: [] };
}

function getAgent(state: SchedulerState, agentId: string): AgentScheduleState {
  if (!state.agents[agentId]) {
    state.agents[agentId] = { lastInvokeAt: null, pendingInvokeAt: null, lastBacklogCount: 0 };
  }
  return state.agents[agentId];
}

/** Check if an agent is within the cooldown period. */
export function isInCooldown(state: SchedulerState, agentId: string, cooldownSec: number): boolean {
  const agent = getAgent(state, agentId);
  if (!agent.lastInvokeAt) return false;
  const elapsed = (Date.now() - new Date(agent.lastInvokeAt).getTime()) / 1000;
  return elapsed < cooldownSec;
}

/** Mark an agent as just invoked. */
export function markInvoked(
  state: SchedulerState,
  agentId: string,
  agentName: string,
  reason: string,
  backlogCount: number,
): void {
  const agent = getAgent(state, agentId);
  agent.lastInvokeAt = new Date().toISOString();
  agent.pendingInvokeAt = null;
  agent.lastBacklogCount = backlogCount;

  state.recentInvocations.unshift({
    agentId,
    agentName,
    reason,
    timestamp: new Date().toISOString(),
    backlogCount,
  });
  if (state.recentInvocations.length > MAX_RECENT_INVOCATIONS) {
    state.recentInvocations = state.recentInvocations.slice(0, MAX_RECENT_INVOCATIONS);
  }
}

/** Schedule a delayed re-invocation for an agent. */
export function scheduleReinvoke(
  state: SchedulerState,
  agentId: string,
  backlogCount: number,
  cfg: AdaptiveConfig,
): void {
  const agent = getAgent(state, agentId);
  const delaySec = backlogCount >= 3 ? cfg.heavyBacklogDelaySec : cfg.backlogDelaySec;
  agent.pendingInvokeAt = new Date(Date.now() + delaySec * 1000).toISOString();
  agent.lastBacklogCount = backlogCount;
}

/** Get all agents with pending invocations that are due. */
export function getDueInvocations(state: SchedulerState): string[] {
  const now = Date.now();
  const due: string[] = [];
  for (const [agentId, agent] of Object.entries(state.agents)) {
    if (agent.pendingInvokeAt && new Date(agent.pendingInvokeAt).getTime() <= now) {
      due.push(agentId);
    }
  }
  return due;
}

/** Clear pending invocation for an agent. */
export function clearPending(state: SchedulerState, agentId: string): void {
  const agent = getAgent(state, agentId);
  agent.pendingInvokeAt = null;
}
