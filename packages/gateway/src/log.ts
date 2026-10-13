/**
 * WS 消息日志：记录 client⇄gateway 的收发信息（截断防刷屏）。
 *
 * PILINK_WS_LOG 环境变量：
 *  - full    全量记录（单条超 400B 截断）
 *  - summary 事件流只记类型+seq，其余全量（默认）
 *  - off     关闭
 *
 * 安全：hello 中的 accessToken 会被脱敏；审计敏感操作仍走 store.audit。
 */
const MODE = (process.env.PILINK_WS_LOG ?? "summary").toLowerCase();
const MAX = 400;

function trunc(s: string): string {
  return s.length > MAX ? `${s.slice(0, MAX)}…(+${s.length - MAX}B)` : s;
}

/** 脱敏：隐藏 accessToken / refreshToken 字段 */
function redact(msg: unknown): unknown {
  if (!msg || typeof msg !== "object") return msg;
  const m = { ...(msg as Record<string, unknown>) };
  for (const k of Object.keys(m)) {
    if (/token/i.test(k) && typeof m[k] === "string") m[k] = "***";
  }
  return m;
}

export function wsLog(dir: "in" | "out", peer: string, msg: unknown): void {
  if (MODE === "off") return;
  const m = msg as Record<string, unknown>;
  // 事件流（text_delta/thinking_delta…）量太大：summary 模式只记类型+seq
  if (m?.t === "event" && MODE !== "full") {
    const ev = (m.ev ?? {}) as Record<string, unknown>;
    console.log(`[pilink:ws] ${dir.padEnd(3)} ${peer}  event seq=${m.seq} ${String(ev.e ?? ev.type ?? "?")}`);
    return;
  }
  console.log(`[pilink:ws] ${dir.padEnd(3)} ${peer}  ${trunc(JSON.stringify(redact(msg)))}`);
}

export function wsConn(event: "connect" | "close", peer: string, extra?: string): void {
  if (MODE === "off") return;
  console.log(`[pilink:ws] ${event === "connect" ? "⭳ connect " : "⭱ close   "} ${peer}${extra ? ` ${extra}` : ""}`);
}
