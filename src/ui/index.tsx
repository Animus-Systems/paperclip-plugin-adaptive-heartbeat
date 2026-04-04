import React from "react";
import { usePluginData, useHostContext } from "@paperclipai/plugin-sdk/ui";

interface InvocationRecord {
  agentName: string;
  reason: string;
  timestamp: string;
  backlogCount: number;
}

interface AgentBacklog {
  name: string;
  backlog: number;
  pending: boolean;
}

interface AdaptiveStatus {
  enabled: boolean;
  cooldownSec: number;
  agentsWithBacklog: AgentBacklog[];
  recentInvocations: InvocationRecord[];
  totalInvocations: number;
}

const muted: React.CSSProperties = {
  color: "rgba(255,255,255,0.45)",
  fontSize: "0.8rem",
};

const badge: React.CSSProperties = {
  display: "inline-block",
  padding: "2px 6px",
  borderRadius: 4,
  fontSize: "0.7rem",
  fontWeight: 500,
  marginRight: 4,
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function AdaptiveHeartbeatWidget() {
  const context = useHostContext();
  const { data } = usePluginData<AdaptiveStatus>("adaptive:status", {
    companyId: context.companyId,
  });

  const status = data ?? {
    enabled: true,
    cooldownSec: 60,
    agentsWithBacklog: [],
    recentInvocations: [],
    totalInvocations: 0,
  };

  return (
    <div style={{ padding: "1rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      {/* Status bar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{
            display: "inline-block", width: 8, height: 8, borderRadius: "50%",
            background: status.enabled ? "rgb(34,197,94)" : "rgb(239,68,68)",
          }} />
          <span style={{ fontSize: "0.8rem", color: "rgba(255,255,255,0.7)" }}>
            {status.enabled ? "Active" : "Disabled"}
          </span>
        </div>
        <span style={muted}>
          {status.totalInvocations} invocations · {status.cooldownSec}s cooldown
        </span>
      </div>

      {/* Agents with backlog */}
      {status.agentsWithBacklog.length > 0 && (
        <div>
          <div style={{ fontSize: "0.75rem", fontWeight: 600, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>
            Active Backlogs
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {status.agentsWithBacklog.map((a) => (
              <span key={a.name} style={{
                ...badge,
                background: a.pending ? "rgba(234,179,8,0.15)" : "rgba(239,68,68,0.12)",
                color: a.pending ? "rgb(250,204,21)" : "rgb(252,165,165)",
                fontSize: "0.75rem",
                padding: "3px 8px",
              }}>
                {a.name} ({a.backlog}) {a.pending ? "⏱" : ""}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Recent invocations */}
      {status.recentInvocations.length > 0 ? (
        <div>
          <div style={{ fontSize: "0.75rem", fontWeight: 600, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>
            Recent Invocations
          </div>
          {status.recentInvocations.slice(0, 8).map((inv, i) => (
            <div key={i} style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "3px 0", fontSize: "0.8rem",
              borderBottom: i < Math.min(status.recentInvocations.length, 8) - 1 ? "1px solid rgba(255,255,255,0.04)" : "none",
            }}>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ color: "rgba(255,255,255,0.8)" }}>{inv.agentName}</span>
                <span style={{ ...badge, background: "rgba(99,102,241,0.2)", color: "rgb(165,168,255)" }}>
                  {inv.reason}
                </span>
                <span style={{ color: "rgba(255,255,255,0.3)", fontSize: "0.7rem" }}>
                  {inv.backlogCount} pending
                </span>
              </span>
              <span style={muted}>{timeAgo(inv.timestamp)}</span>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ ...muted, fontStyle: "italic" }}>
          No invocations yet. Agents will be invoked automatically when issues are assigned.
        </div>
      )}
    </div>
  );
}
