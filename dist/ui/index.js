// src/ui/index.tsx
import { usePluginData, useHostContext } from "@paperclipai/plugin-sdk/ui";
import { jsx, jsxs } from "react/jsx-runtime";
var muted = {
  color: "rgba(255,255,255,0.45)",
  fontSize: "0.8rem"
};
var badge = {
  display: "inline-block",
  padding: "2px 6px",
  borderRadius: 4,
  fontSize: "0.7rem",
  fontWeight: 500,
  marginRight: 4
};
function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 6e4) return "just now";
  if (diff < 36e5) return `${Math.floor(diff / 6e4)}m ago`;
  if (diff < 864e5) return `${Math.floor(diff / 36e5)}h ago`;
  return `${Math.floor(diff / 864e5)}d ago`;
}
function AdaptiveHeartbeatWidget() {
  const context = useHostContext();
  const { data } = usePluginData("adaptive:status", {
    companyId: context.companyId
  });
  const status = data ?? {
    enabled: true,
    cooldownSec: 60,
    agentsWithBacklog: [],
    recentInvocations: [],
    totalInvocations: 0
  };
  return /* @__PURE__ */ jsxs("div", { style: { padding: "1rem", display: "flex", flexDirection: "column", gap: "0.75rem" }, children: [
    /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between" }, children: [
      /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 6 }, children: [
        /* @__PURE__ */ jsx("span", { style: {
          display: "inline-block",
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: status.enabled ? "rgb(34,197,94)" : "rgb(239,68,68)"
        } }),
        /* @__PURE__ */ jsx("span", { style: { fontSize: "0.8rem", color: "rgba(255,255,255,0.7)" }, children: status.enabled ? "Active" : "Disabled" })
      ] }),
      /* @__PURE__ */ jsxs("span", { style: muted, children: [
        status.totalInvocations,
        " invocations \xB7 ",
        status.cooldownSec,
        "s cooldown"
      ] })
    ] }),
    status.agentsWithBacklog.length > 0 && /* @__PURE__ */ jsxs("div", { children: [
      /* @__PURE__ */ jsx("div", { style: { fontSize: "0.75rem", fontWeight: 600, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }, children: "Active Backlogs" }),
      /* @__PURE__ */ jsx("div", { style: { display: "flex", flexWrap: "wrap", gap: 4 }, children: status.agentsWithBacklog.map((a) => /* @__PURE__ */ jsxs("span", { style: {
        ...badge,
        background: a.pending ? "rgba(234,179,8,0.15)" : "rgba(239,68,68,0.12)",
        color: a.pending ? "rgb(250,204,21)" : "rgb(252,165,165)",
        fontSize: "0.75rem",
        padding: "3px 8px"
      }, children: [
        a.name,
        " (",
        a.backlog,
        ") ",
        a.pending ? "\u23F1" : ""
      ] }, a.name)) })
    ] }),
    status.recentInvocations.length > 0 ? /* @__PURE__ */ jsxs("div", { children: [
      /* @__PURE__ */ jsx("div", { style: { fontSize: "0.75rem", fontWeight: 600, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }, children: "Recent Invocations" }),
      status.recentInvocations.slice(0, 8).map((inv, i) => /* @__PURE__ */ jsxs("div", { style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "3px 0",
        fontSize: "0.8rem",
        borderBottom: i < Math.min(status.recentInvocations.length, 8) - 1 ? "1px solid rgba(255,255,255,0.04)" : "none"
      }, children: [
        /* @__PURE__ */ jsxs("span", { style: { display: "flex", alignItems: "center", gap: 6 }, children: [
          /* @__PURE__ */ jsx("span", { style: { color: "rgba(255,255,255,0.8)" }, children: inv.agentName }),
          /* @__PURE__ */ jsx("span", { style: { ...badge, background: "rgba(99,102,241,0.2)", color: "rgb(165,168,255)" }, children: inv.reason }),
          /* @__PURE__ */ jsxs("span", { style: { color: "rgba(255,255,255,0.3)", fontSize: "0.7rem" }, children: [
            inv.backlogCount,
            " pending"
          ] })
        ] }),
        /* @__PURE__ */ jsx("span", { style: muted, children: timeAgo(inv.timestamp) })
      ] }, i))
    ] }) : /* @__PURE__ */ jsx("div", { style: { ...muted, fontStyle: "italic" }, children: "No invocations yet. Agents will be invoked automatically when issues are assigned." })
  ] });
}
export {
  AdaptiveHeartbeatWidget
};
//# sourceMappingURL=index.js.map
