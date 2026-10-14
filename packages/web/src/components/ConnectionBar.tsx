import { Loader2, CloudOff } from "lucide-react";
import { useApp } from "../lib/store";

/** 连接状态条：online 时隐藏；非通栏，细条弱化存在感 */
export function ConnectionBar() {
  const conn = useApp((s) => s.conn);
  if (conn === "online") return null;
  return (
    <div className="flex items-center justify-center gap-1.5 border-b border-line bg-s1 px-3 py-1 text-xs text-dim">
      {conn === "connecting" ? (
        <Loader2 size={12} className="animate-spin" />
      ) : (
        <CloudOff size={12} />
      )}
      {conn === "connecting" ? "连接中…（自动重连，消息不丢失）" : "已离线：等待网络恢复"}
    </div>
  );
}
