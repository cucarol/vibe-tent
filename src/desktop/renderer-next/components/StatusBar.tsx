export type StatusBarProps = {
  connection: "online" | "offline" | "reconnecting";
  projection: "fresh" | "stale" | "unresolved" | "error";
  nodeCount: number;
};

export function StatusBar({ connection, projection, nodeCount }: StatusBarProps) {
  const connectionLabel = connection === "online" ? "服务已连接" : connection === "reconnecting" ? "正在重连" : "连接已断开";
  const projectionLabel = projection === "fresh"
    ? "投影已同步"
    : projection === "stale"
      ? "投影已过期"
      : projection === "unresolved"
        ? "节点未解析"
        : "投影加载失败";
  return (
    <footer className="tn-status" data-region="status" aria-label="工作区诊断">
      <span className="tn-status-item" data-state={connection}>{connectionLabel}</span>
      <span className="tn-status-separator" aria-hidden="true" />
      <span className="tn-status-item" data-state={projection}>{projectionLabel}</span>
      <span className="tn-status-spacer" />
      <span>{nodeCount} 个节点</span>
    </footer>
  );
}
