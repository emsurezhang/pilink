#!/usr/bin/env node
/* PiLink 一键重载：全量构建 → 部署 web/bridge 产物 → 重启 Gateway
 *
 * 用法（仓库根目录）：
 *   node scripts/dev-reload.mjs
 *   pnpm reload
 *
 * 行为：
 *  1. pnpm -r build（任一包构建失败则中止，不会动正在运行的 Gateway）
 *  2. packages/web/dist   → ~/.pilink/web/
 *  3. packages/bridge/dist → ~/.pilink/bridge/index.js（若存在）
 *  4. 停掉旧 Gateway（pid 文件 + pgrep 兜底）→ 后台启动新进程
 *  5. 轮询 127.0.0.1:7788 直到端口可连接
 */
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PILINK = path.join(homedir(), ".pilink");
const PID_FILE = path.join(PILINK, "gateway.pid");
const LOG_FILE = path.join(PILINK, "logs", "gateway.log");
const GATEWAY_ENTRY = path.join(ROOT, "packages", "gateway", "dist", "index.js");
const PORT = Number(process.env.PILINK_PORT || 7788);

const step = (msg) => console.log(`\x1b[36m▶ ${msg}\x1b[0m`);
const ok = (msg) => console.log(`\x1b[32m✓ ${msg}\x1b[0m`);
const die = (msg) => { console.error(`\x1b[31m✗ ${msg}\x1b[0m`); process.exit(1); };

// ── 1. 全量构建 ─────────────────────────────────────────────
step("构建所有包 (pnpm -r build) ...");
const build = spawnSync("corepack", ["pnpm", "-r", "build"], { cwd: ROOT, stdio: "inherit" });
if (build.status !== 0) die("构建失败，Gateway 保持原状，未重启。");
ok("构建完成");

// ── 2. 部署 web 产物 ────────────────────────────────────────
step("部署 web 产物 → ~/.pilink/web/ ...");
cpSync(path.join(ROOT, "packages", "web", "dist"), path.join(PILINK, "web"), { recursive: true });
ok("web 已部署（浏览器需硬刷新 Cmd+Shift+R 清 PWA 缓存）");

// ── 3. 部署 bridge 产物（可选）───────────────────────────────
const bridgeDist = path.join(ROOT, "packages", "bridge", "dist", "index.js");
if (existsSync(bridgeDist)) {
  step("部署 bridge 产物 → ~/.pilink/bridge/index.js ...");
  mkdirSync(path.join(PILINK, "bridge"), { recursive: true });
  cpSync(bridgeDist, path.join(PILINK, "bridge", "index.js"));
  ok("bridge 已部署（Attach 模式需重连后生效）");
}

// ── 4. 重启 Gateway ────────────────────────────────────────
step("重启 Gateway ...");
const killPid = (pid, sig = "SIGTERM") => {
  try { process.kill(pid, sig); return true; } catch { return false; }
};
// pid 文件
if (existsSync(PID_FILE)) {
  const pid = Number(readFileSync(PID_FILE, "utf8").trim());
  if (pid && killPid(pid)) console.log(`  已按 pid 文件停止旧进程 (pid=${pid})`);
}
// pgrep 兜底：杀掉所有指向本仓库 gateway dist 的进程
try {
  const out = execFileSync("pgrep", ["-f", GATEWAY_ENTRY], { encoding: "utf8" }).trim();
  for (const pid of out.split("\n").filter(Boolean).map(Number)) {
    if (pid !== process.pid && killPid(pid)) console.log(`  已停止残留进程 (pid=${pid})`);
  }
} catch { /* pgrep 无匹配会抛错，忽略 */ }

// 等待端口释放（旧进程 SIGTERM 后内核尚未回收时直接启动会 EADDRINUSE）
const portFree = () =>
  new Promise((resolve) => {
    const s = createConnection({ host: "127.0.0.1", port: PORT });
    s.once("connect", () => { s.end(); resolve(false); });
    s.once("error", () => { s.destroy(); resolve(true); });
  });
for (let i = 0; i < 25; i++) {
  if (await portFree()) break;
  await new Promise((r) => setTimeout(r, 200));
  if (i === 24) console.warn("  警告：端口尚未释放，仍尝试启动…");
}

mkdirSync(path.join(PILINK, "logs"), { recursive: true });
const logFd = (await import("node:fs")).openSync(LOG_FILE, "a");
const child = spawn(process.execPath, [GATEWAY_ENTRY], {
  cwd: ROOT,
  detached: true,
  stdio: ["ignore", logFd, logFd],
});
child.unref();
writeFileSync(PID_FILE, String(child.pid));
ok(`Gateway 已启动 (pid=${child.pid})，日志: ${LOG_FILE}（tail -f 查看）`);

// ── 5. 等待端口就绪 ────────────────────────────────────────
step(`等待 127.0.0.1:${PORT} 就绪 ...`);
const waitPort = (ms = 15000) =>
  new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const tryOnce = () => {
      const s = createConnection({ host: "127.0.0.1", port: PORT });
      s.once("connect", () => { s.end(); resolve(); });
      s.once("error", () => {
        s.destroy();
        if (Date.now() > deadline) reject(new Error("超时"));
        else setTimeout(tryOnce, 200);
      });
    };
    tryOnce();
  });
try {
  await waitPort();
  ok(`Gateway 就绪: http://localhost:${PORT}\n全部完成 ✅`);
} catch {
  die(`端口 ${PORT} 未就绪，请查看日志: tail -50 ${LOG_FILE}`);
}
