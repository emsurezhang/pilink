/* 流式 prompt E2E：验证 thinking_delta / text_delta / message_end / agent_settled 经 Gateway 广播 */
import { webcrypto } from "node:crypto";
import WebSocket from "../packages/gateway/node_modules/ws/index.js";

const BASE = "http://127.0.0.1:7788";
const b64url = (buf) => Buffer.from(buf).toString("base64url");

const pairCode = (await (await fetch(`${BASE}/api/pair/create`, { method: "POST" })).json()).code;
const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const pub = b64url(await webcrypto.subtle.exportKey("spki", keys.publicKey));
const { deviceId } = await (
  await fetch(`${BASE}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: pairCode, deviceName: "e2e-stream", devicePubKey: pub }),
  })
).json();
const ch = await (
  await fetch(`${BASE}/api/auth/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId }),
  })
).json();
const sig = b64url(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, new TextEncoder().encode(ch.challenge)));
const tokens = await (
  await fetch(`${BASE}/api/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId, signature: sig }),
  })
).json();

const ws = new WebSocket("ws://127.0.0.1:7788/ws");
const pending = new Map();
let seq = 0;
const eventCounts = {};
let gotTextDelta = false, gotThinking = false, gotSettled = false, lastAssistantText = "";
ws.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.t === "event") {
    const t = m.ev.type;
    eventCounts[t] = (eventCounts[t] ?? 0) + 1;
    if (t === "message_update" && m.ev.assistantMessageEvent?.type === "text_delta") gotTextDelta = true;
    if (t === "message_update" && m.ev.assistantMessageEvent?.type?.startsWith("thinking")) gotThinking = true;
    if (t === "agent_settled") gotSettled = true;
    if (t === "message_end" && m.ev.message?.role === "assistant") {
      lastAssistantText = Array.isArray(m.ev.message.content)
        ? m.ev.message.content.filter((b) => b.type === "text").map((b) => b.text).join("")
        : "";
    }
  }
  if ((m.t === "rpc_res" || m.t === "gw_res") && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const rpc = (sessionKey, cmd) => {
  const id = `s-${++seq}`;
  return new Promise((r) => {
    pending.set(id, r);
    ws.send(JSON.stringify({ t: "rpc", id, sessionKey, cmd }));
  });
};
const gw = (op) => {
  const id = `s-${++seq}`;
  return new Promise((r) => {
    pending.set(id, r);
    ws.send(JSON.stringify({ t: "gw", id, op }));
  });
};
await new Promise((r) => ws.on("open", r));
ws.send(JSON.stringify({ t: "hello", v: 1, deviceId, accessToken: tokens.accessToken }));
await new Promise((r) => ws.on("message", r));

const wsList = await gw({ op: "workspaces.list" });
const workspaceId = wsList.data.workspaces[0].workspaceId;
const open = await gw({ op: "session.open", workspaceId, sessionPath: "new" });
const sessionKey = open.data.sessionKey;
console.log("opened:", sessionKey);

const res = await rpc(sessionKey, { type: "prompt", message: "用一句话回答：1+1等于几？" });
console.log("prompt accepted:", res.res?.success, res.res?.data);

// 等待 agent_settled（最长 90s）
const deadline = Date.now() + 90_000;
while (!gotSettled && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));

console.log("text_delta streamed:", gotTextDelta);
console.log("thinking events:", gotThinking);
console.log("agent_settled:", gotSettled);
console.log("event counts:", JSON.stringify(eventCounts));
console.log("assistant text:", JSON.stringify(lastAssistantText.slice(0, 120)));

await gw({ op: "session.release", sessionKey });
ws.close();
process.exit(gotSettled && gotTextDelta ? 0 : 1);
