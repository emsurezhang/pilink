import { useApp } from "../lib/store";

export function ConnectionBar() {
  const conn = useApp((s) => s.conn);
  const conflict = useApp((s) => s.conflict);
  if (conn === "online" && !conflict) return null;
  return (
    <div className={`conn-bar ${conn === "online" ? "warn" : "bad"}`}>
      {conflict
        ? `⚠ ${conflict}`
        : conn === "connecting"
          ? "连接中…（自动重连，消息不丢失）"
          : "已离线：等待网络恢复"}
    </div>
  );
}
