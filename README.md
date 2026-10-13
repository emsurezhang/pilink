# PiLink

在手机与 Mac 本机之间无缝切换的 Pi Agent 客户端 —— 手机与本机终端共享**同一个 Pi 会话**。

> 实现依据：《docs/PiLink-01-需求文档.md》《docs/PiLink-02-设计文档.md》（v0.2）

## 架构

```
手机 PWA ──WSS──▶ Nginx(8443, IP证书) ──▶ frps ──隧道── frpc ──▶ Gateway(127.0.0.1:7788)
                  │                                              │
局域网/本机 ──────┘（直连 Gateway）                                ├─ Host: pi --mode rpc 子进程（持有会话）
                                                                 └─ Attach: Bridge 扩展（本机 TUI 里的 pi）
                                                                        │
                                                              ~/.pi/agent/sessions/*.jsonl（真相源）
```

- **packages/protocol**：Client⇄Gateway 信封、zod 校验、RPC 透传白名单、内置命令表、LF 分帧（复用 Pi 的 `rpc-types`）
- **packages/gateway**：Fastify + WS。Host 驱动（`pi --mode rpc` 子进程）、租约（单写者，SYNC-2）、
  会话列表（等价 `/resume`）、Role 管理（受管 `.pi/SYSTEM.md` 符号链接）、设备配对/WebCrypto 挑战签名/JWT、
  seq 环形缓冲 + 增量补齐、presence、审计日志、推送（VAPID）、`node:sqlite` 持久化
- **packages/bridge**：Pi 扩展。本机 TUI 接入 Gateway（Attach 模式）、事件转发、reload/系统提示词补缺、租约登记与接管确认
- **packages/web**：React PWA。流式 thinking/工具卡片/Markdown、命令面板（内置+动态）、
  模型/思考/角色/会话树底部抽屉、Steer/Follow-up 长按发送、断线重连增量补齐、多设备 presence；
  还包含用户输入去重、待确认消息队列展示、超时/error 提示和更稳定的发送失败恢复
- **packages/cli**：`pilink start / pair / release / doctor / install-launchd`
- **deploy/**：frps/frpc、Nginx（IP 证书 + WSS）、launchd 模板

## 快速开始

```bash
corepack pnpm install
corepack pnpm -r build

# 部署 web 产物（Gateway 静态托管）
cp -r packages/web/dist/* ~/.pilink/web/

# 启动 Gateway（仅监听 127.0.0.1:7788）
node packages/gateway/dist/index.js

# 本机使用：http://localhost:7788
# 手机配对：本机执行配对码生成，手机输入
curl -X POST http://127.0.0.1:7788/api/pair/create   # 或接入 CLI `pilink pair`
```

配置（`~/.pilink/config.json`）：`port` / `bridgePort` / `piPath` / `workspaces`（白名单）/
`maxDevices` / `hostLoadBridge` / `vapid*`（推送）等。

### Bridge（Attach 模式，可选）

```bash
mkdir -p ~/.pilink/bridge && cp packages/bridge/dist/index.js ~/.pilink/bridge/index.js
# Host 模式会自动给 pi 加 --extension ~/.pilink/bridge/index.js；
# 本机 TUI 可将该扩展放入 ~/.pi/agent/extensions/ 常驻加载
```

## 已实现 vs 里程碑

| 里程碑 | 状态 |
|---|---|
| M1 Host MVP | ✅ 会话同步（SYNC-1/2/3/5/6）、命令面板与内置命令、流式/thinking/工具卡片、交接、本地访问 |
| M2 Role 与远程 | ✅ Role 选择器（ROLE-1~7）、设备配对与认证（SEC-1/3/4）、PWA；⏳ frp/IP 证书需 ECS（NET-1/5/6，S11 Spike） |
| M3 Attach | 🚧 Bridge 已实现（事件转发/接管确认/消息注入），能力以 M0 Spike S1/S2 验证为准 |
| M4 打磨 | 部分（队列可见、手势、弱网重连）；`pilink doctor` ✅ |

## 测试

```bash
# 端到端冒烟（需 Gateway 运行 + 测试工作区在白名单）：
node scripts/e2e-smoke.mjs    # 配对→签名→WS→会话→bash→命令→释放→吊销，16 项
node scripts/e2e-stream.mjs   # 真实模型 prompt：text_delta/thinking/agent_settled 流式验证
corepack pnpm -r typecheck
```

## 与设计的已知差异

- **持久化用 `node:sqlite`**（Node 24 内置）替代 better-sqlite3：后者在 Node 24 下有已知随机 GC 崩溃；
  接口等价，无原生依赖
- Markdown 渲染用 `marked` 每帧重渲染最后一条（§7.2 增量解析的务实降级）；shiki 高亮未接入
- 树导航（切换叶子）在 Attach 前为只读 + fork（§6.3，Spike S6）

## 安全要点

- Gateway 仅监听回环；Bridge 通道独立端口仅回环；公网必经 frp TLS + Nginx TLS（HSTS）
- 配对码一次性 5 分钟有效；设备密钥为不可导出 ECDSA P-256（WebCrypto）；JWT 15 分钟 + refresh 轮换 + 可吊销
- RPC 透传白名单；settings.patch 字段白名单；不读取/下发 `auth.json` 等敏感文件；审计日志脱敏

## 远程验证
验证：curl -I https://<ECS_IP或域名>:8443 → 200# pilink
