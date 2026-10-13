/* PiLink E2E 冒烟测试：配对 → 挑战签名 → WS → 会话操作 */
import { webcrypto } from "node:crypto";
import WebSocket from "../packages/gateway/node_modules/ws/index.js";

const BASE = "http://127.0.0.1:7788";
const b64url = (buf) => Buffer.from(buf).toString("base64url");

const pairCode = (await (await fetch(`${BASE}/api/pair/create`, { method: "POST" })).json()).code;
console.log("1. pair code:", pairCode);

const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const pub = b64url(await webcrypto.subtle.exportKey("spki", keys.publicKey));
const pairRes = await (
  await fetch(`${BASE}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: pairCode, deviceName: "e2e-test", devicePubKey: pub }),
  })
).json();
console.log("2. paired:", pairRes.deviceId);

const ch = await (
  await fetch(`${BASE}/api/auth/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: pairRes.deviceId }),
  })
).json();
const sig = b64url(
  await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, new TextEncoder().encode(ch.challenge)),
);
const vf = await (
  await fetch(`${BASE}/api/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: pairRes.deviceId, signature: sig }),
  })
).json();
console.log("3. tokens:", !!vf.accessToken, !!vf.refreshToken);

// WS
const ws = new WebSocket("ws://127.0.0.1:7788/ws");
const waiters = new Map();
let seq = 0;
const pending = new Map();
let events = [];
ws.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.t === "event") events.push(m);
  if (m.t === "rpc_res" && pending.has(m.id)) { pending.get(m.id)(m.res); pending.delete(m.id); }
  if (m.t === "gw_res" && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  waiters.get(m.t)?.(m);
});
await new Promise((r) => ws.on("open", r));
const wsId = (p) => `t-${++seq}`;
function rpc(sessionKey, cmd) {
  const id = wsId();
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ t: "rpc", id, sessionKey, cmd }));
  });
}
function gw(op) {
  const id = wsId();
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ t: "gw", id, op }));
  });
}
ws.send(JSON.stringify({ t: "hello", v: 1, deviceId: pairRes.deviceId, accessToken: vf.accessToken }));
const hello = await new Promise((r) => waiters.set("hello_ok", r));
console.log("4. hello_ok: server", hello.serverVersion, "pi", hello.piVersion);

const wsList = await gw({ op: "workspaces.list" });
console.log("5. workspaces:", JSON.stringify(wsList.data));
const workspaceId = wsList.data.workspaces[0].workspaceId;

const sessions = await gw({ op: "sessions.list", workspaceId });
console.log("6. sessions:", sessions.data.sessions.length);

const open = await gw({ op: "session.open", workspaceId, sessionPath: "new" });
console.log("7. open:", JSON.stringify(open.data ?? open.error));
const sessionKey = open.data.sessionKey;

const state = await rpc(sessionKey, { type: "get_state" });
console.log("8. state:", state.success, "streaming:", state.data?.isStreaming, "sessionFile:", state.data?.sessionFile);

const bash = await rpc(sessionKey, { type: "bash", command: "echo hello-pilink", excludeFromContext: true });
console.log("9. bash:", bash.success, JSON.stringify(bash.data));

const cmds = await gw({ op: "commands.list", sessionKey });
console.log("10. commands: builtin", cmds.data.builtin.length, "dynamic", cmds.data.dynamic.length);

const stats = await rpc(sessionKey, { type: "get_session_stats" });
console.log("11. stats:", stats.success, "messages:", stats.data?.totalMessages);

const entries = await rpc(sessionKey, { type: "get_entries" });
console.log("12. entries:", entries.success, "count:", entries.data?.entries?.length, "leaf:", entries.data?.leafId);

const name = await rpc(sessionKey, { type: "set_session_name", name: "e2e-test-session" });
console.log("13. set_session_name:", name.success);

// 事件流检查：bash 应产生 bash_execution_update 事件
await new Promise((r) => setTimeout(r, 500));
console.log("14. events received:", events.length, events.map((e) => e.ev.type).slice(0, 8));

// 会话释放
const rel = await gw({ op: "session.release", sessionKey });
console.log("15. release:", JSON.stringify(rel.data ?? rel.error));

// 吊销设备后 token 应失效
const dev = await gw({ op: "devices.revoke", deviceId: pairRes.deviceId });
console.log("16. revoke:", JSON.stringify(dev.data ?? dev.error));

ws.close();
console.log("E2E DONE");
process.exit(0);
