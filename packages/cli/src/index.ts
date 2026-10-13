#!/usr/bin/env node
/**
 * pilink CLI：start / pair / release / doctor / install-launchd
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const [, , cmd, ...args] = process.argv;
const DATA_DIR = process.env.PILINK_DATA_DIR ?? join(homedir(), ".pilink");
const GATEWAY_URL = process.env.PILINK_URL ?? "http://127.0.0.1:7788";

function usage(): never {
  console.log(`pilink — Pi Agent 远程客户端

用法：
  pilink start              前台启动 Gateway
  pilink pair               生成本机配对码（手机输入后完成配对）
  pilink release <会话路径>  释放托管（等价 /quit）
  pilink doctor             环境检查（Pi 版本、端口、证书、睡眠设置）
  pilink install-launchd    安装 Gateway 自启服务（launchd）
  pilink uninstall-launchd  移除自启服务
`);
  process.exit(0);
}

async function start() {
  const { createGateway } = await import("@pilink/gateway");
  await createGateway();
}

async function pair() {
  const res = await fetch(`${GATEWAY_URL}/api/pair/create`, { method: "POST" });
  if (!res.ok) {
    console.error("无法连接 Gateway（请先 pilink start）");
    process.exit(1);
  }
  const { code, expiresAt } = (await res.json()) as { code: string; expiresAt: number };
  console.log(`
  ┌──────────────────────────────┐
  │       配对码： ${code}        │
  └──────────────────────────────┘
  在手机上打开 PiLink，输入该配对码。
  ${new Date(expiresAt).toLocaleTimeString()} 前有效（5 分钟）。
`);
}

async function release() {
  const sessionPath = args[0];
  if (!sessionPath) {
    console.error("用法：pilink release <会话路径>");
    process.exit(1);
  }
  console.log("请在手机端「结束托管」，或 Ctrl+C 本机终端中的 pi。");
  console.log(`恢复命令：pi --session ${sessionPath}`);
}

async function doctor() {
  const checks: [string, () => string][] = [
    [
      "pi 版本",
      () => {
        try {
          return execFileSync("pi", ["--version"], { encoding: "utf8" }).trim().split("\n")[0];
        } catch {
          throw new Error("pi 不在 PATH");
        }
      },
    ],
    [
      "Gateway 端口 7788",
      () => {
        try {
          execFileSync("nc", ["-z", "127.0.0.1", "7788"], { stdio: "pipe" });
          return "监听中";
        } catch {
          throw new Error("未监听（pilink start 启动）");
        }
      },
    ],
    [
      "Bridge 端口 7789",
      () => {
        try {
          execFileSync("nc", ["-z", "127.0.0.1", "7789"], { stdio: "pipe" });
          return "监听中";
        } catch {
          throw new Error("未监听");
        }
      },
    ],
    [
      "frpc 进程",
      () => {
        try {
          execFileSync("pgrep", ["-x", "frpc"], { stdio: "pipe" });
          return "运行中";
        } catch {
          throw new Error("未运行（远程访问不可用）");
        }
      },
    ],
    [
      "证书（frp 场景）",
      () => {
        for (const p of ["/etc/pilink/certs/ip/fullchain.pem"]) {
          if (existsSync(p)) return `${p} 存在（注意 IP 证书约 6 天有效）`;
        }
        return "本机无证书文件（证书在 ECS 上）";
      },
    ],
    [
      "睡眠设置",
      () => {
        const out = execFileSync("pmset", ["-g"], { encoding: "utf8" });
        const m = out.match(/sleep\s+(\d+)/);
        return `系统睡眠 ${m?.[1] ?? "?"} 分钟（合盖需外接电源；建议配合「保持唤醒」开关）`;
      },
    ],
    [
      "数据目录",
      () => (existsSync(DATA_DIR) ? `${DATA_DIR} 存在` : `${DATA_DIR} 不存在`),
    ],
  ];
  let failed = 0;
  for (const [name, fn] of checks) {
    try {
      console.log(`✅ ${name}: ${fn()}`);
    } catch (e) {
      failed++;
      console.log(`❌ ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  process.exit(failed > 0 ? 1 : 0);
}

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", "com.pilink.gateway.plist");
}

function installLaunchd() {
  const node = process.execPath;
  const cliEntry = join(DATA_DIR, "pilink.js"); // 安装后由用户放置或指向 packages/cli/dist
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.pilink.gateway</string>
  <key>ProgramArguments</key>
  <array><string>${node}</string><string>${cliEntry}</string><string>start</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${DATA_DIR}/gateway.log</string>
  <key>StandardErrorPath</key><string>${DATA_DIR}/gateway.err</string>
</dict>
</plist>`;
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(plistPath(), plist);
  try {
    execFileSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/com.pilink.gateway`], { stdio: "ignore" });
  } catch {
    /* 未加载 */
  }
  execFileSync("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 0}`, plistPath()]);
  console.log(`已安装并加载 ${plistPath()}`);
  console.log(`注意：ProgramArguments 指向 ${cliEntry}，请确保该入口存在（全局安装后自动正确）。`);
}

function uninstallLaunchd() {
  try {
    execFileSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/com.pilink.gateway`], { stdio: "ignore" });
  } catch {
    /* ignore */
  }
  if (existsSync(plistPath())) {
    writeFileSync(plistPath(), readFileSync(plistPath()));
    import("node:fs").then((fs) => fs.unlinkSync(plistPath()));
  }
  console.log("已移除 com.pilink.gateway");
}

switch (cmd) {
  case undefined:
  case "help":
  case "--help":
    usage();
    break;
  case "start":
    void start();
    break;
  case "pair":
    void pair();
    break;
  case "release":
    void release();
    break;
  case "doctor":
    void doctor();
    break;
  case "install-launchd":
    installLaunchd();
    break;
  case "uninstall-launchd":
    uninstallLaunchd();
    break;
  default:
    console.error(`未知命令：${cmd}`);
    usage();
}
