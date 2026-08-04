import { Button } from "../ui/index.js";
import type { DesktopConnection } from "../model/desktop-recovery.js";

export function ConnectionBanner(props: {
  connection: Exclude<DesktopConnection, "online">;
  onRetry?: () => void;
}) {
  const { connection, onRetry } = props;
  return (
    <div className="tn-connection-banner" role="alert">
      <span>
        {connection === "connecting"
          ? "正在连接本地服务；节点事实尚未加载。"
          : connection === "reconnecting"
            ? "正在重新连接本地服务。画布位置会保留，节点事实暂不视为最新。"
            : "本地服务连接已断开。画布位置会保留，节点事实暂不视为最新。"}
      </span>
      {onRetry ? <Button size="compact" onClick={onRetry}>重试连接</Button> : null}
    </div>
  );
}
