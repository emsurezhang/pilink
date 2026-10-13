# PiLink 需求文档

> 项目代号：**PiLink**（暂定）——一个可在手机与 Mac 本机之间无缝切换的 Pi Agent 客户端
> 版本：v0.2（草案，已纳入第一轮确认结论）　日期：2026-10-11　语言：TypeScript
> 配套文档：《PiLink-02-设计文档.md》

---

## 0. 文档约定

| 标记 | 含义 |
|---|---|
| ✅ | 已对照 Pi 官方文档核对（pi.dev/docs，Pi 1.0） |
| ⚠️ | 依赖 Pi 内部/扩展 API，需在 Spike 中验证后才能定稿 |
| P0 / P1 / P2 | 必须 / 应当 / 可选 |

需求编号规则：`SYNC`（会话同步）、`CMD`（命令与输入）、`RND`（渲染）、`ROLE`（角色提示词）、`WS`（工作区/会话管理）、`MOB`（移动端体验）、`NET`（远程访问）、`SEC`（安全）。

---

## 1. 背景与问题

当前通过「飞书插件」远程控制 Mac 上的 Pi Agent，存在以下问题：

| # | 问题 | 根因（初步判断） |
|---|---|---|
| 1 | 飞书里输入 `/skill` 等指令没有任何补全/菜单提示，无法使用 Pi 的全部指令 | 飞书是通用 IM，没有 TUI 式命令面板；插件只做了文本透传 |
| 2 | 飞书与本机终端里的 Pi 不是同一个 Session，历史不共享 | 飞书插件独立起了一个 Pi 进程/会话，与终端 TUI 的会话互不相通 |
| 3 | 只显示最终结果，看不到 thinking 过程 | IM 通道只转发最终文本，未消费流式事件中的 thinking 块 |
| 4 | 同一工作区下无法选择不同的 `SYSTEM.md`（Agent Role Prompt） | Pi 只按固定路径读取 `.pi/SYSTEM.md`，没有“选择”概念 |

**核心诉求**：做一个自有的 Pi Agent 客户端，替换飞书，使「手机」和「本机终端」成为同一个 Pi 会话的两个入口。

---

## 2. 目标与非目标

### 2.1 目标

1. **同会话**：手机端与本机 Pi 共享同一个 Session（同一份历史、同一上下文），可随时切换，也可同时在线观看。
2. **类 TUI 体验**：支持 Pi 全部指令，带命令面板/补全；渲染 thinking、工具调用、流式输出。
3. **移动端优化输入**：针对手机键盘、单手操作、弱网重连做专门设计。
4. **角色提示词可选**：同一工作区内选择任意 `SYSTEM.md`（或回到默认），选择后自动 reload。
5. **安全的远程访问**：Mac 本机服务经 frp 反向代理到阿里云公网 IP，可在外网使用。
6. **TypeScript 全栈实现**。

### 2.2 非目标（v1 不做）

- 不做多用户/团队协作（单用户、多设备）。
- 不重新实现 Agent 本身；Agent 能力完全复用 Pi。
- 不做原生 iOS/Android App（v1 用 PWA，后续可用 Capacitor 包壳）。
- 不做云端托管 Pi（Agent 始终运行在用户的 Mac 上）。
- 不迁移飞书里的历史会话（已确认）。
- 不依赖域名：公网入口为「阿里云北京 ECS 公网 IP + 非标准端口」（已确认）。
- 不支持 Windows/Linux 作为被控主机（v1 仅 macOS；设计不刻意排斥）。

---

## 3. 用户与典型场景

**用户画像**：单个开发者，主力机是 MacBook，用 Pi 做 Agent 开发，经常离开工位但希望继续推进/监督任务。

| 场景 | 描述 |
|---|---|
| S1 离开工位继续对话 | 在终端里和 Pi 聊到一半出门，手机打开 PiLink，看到完整历史，接着发消息 |
| S2 远程盯任务 | 在手机上发起长任务（重构/跑测试），用 thinking 与工具卡片判断它是否跑偏，必要时 steer 或 abort |
| S3 回到工位接管 | 回到电脑，终端里 `pi -c`（或本机已开的 TUI）直接看到手机上发生的一切 |
| S4 切换 Agent 角色 | 正在开发一个 Agent：根目录 `SYSTEM.md` 是「Coding Agent」，`my-agent/SYSTEM.md` 是「被开发 Agent 的 Role」。在手机上一键切换，Pi 立即以新角色工作 |
| S5 恢复默认 | 取消选择任何 SYSTEM.md，回到 Pi 默认系统提示词 |
| S6 弱网/切网 | 手机从 Wi‑Fi 切到 5G、锁屏再解锁，连接自动恢复且不丢消息 |

---

## 4. 术语

| 术语 | 说明 |
|---|---|
| Pi | `@earendil-works/pi-coding-agent`（旧包名 `@mariozechner/pi-coding-agent` 已弃用）✅ |
| Session | Pi 的会话：`~/.pi/agent/sessions/` 下按工作目录分组的 JSONL 文件，追加写入的树结构，条目有稳定 id 与 parentId ✅ |
| Workspace | 一个工作目录（cwd），决定项目资源、`.pi/` 配置、会话分组 ✅ |
| Gateway | 运行在 Mac 上的 PiLink 后端服务（Node/TypeScript） |
| Client | 手机/浏览器上的 PiLink PWA |
| Bridge | 安装进 Pi 的 PiLink 扩展，用于把「本机 TUI 里的 Pi 进程」接入 Gateway |
| Host 模式 | Gateway 自己拉起 `pi --mode rpc` 进程并持有会话 |
| Attach 模式 | 会话由本机 TUI 里的 Pi 进程持有，Gateway 通过 Bridge 接入 |
| Role | 本文中指 `SYSTEM.md`（Pi 里作为「替换默认系统提示词」的文件）✅ |

---

## 5. 功能需求

### 5.1 会话同步（SYNC）——对应问题 2

| ID | 需求 | 优先级 | 验收标准 |
|---|---|---|---|
| SYNC-1 | 手机与本机使用**同一个 Session 文件**，历史完全一致 | P0 | 终端对话 5 轮后手机端打开，消息、工具调用、compaction 摘要与终端一致 |
| SYNC-2 | **同一时刻只有一个进程写同一个 Session**（防止双写造成上下文分叉） | P0 | 任何路径下都不会出现两个 Pi 进程同时向同一 JSONL 追加；冲突时有明确提示 |
| SYNC-3 | 提供「交接」：手机托管 ⇄ 本机接管，可在 UI 上一键切换，并给出本机恢复命令（如 `pi --session <path>`） | P0 | 交接后另一端看到的最后一条消息与交接前完全一致 |
| SYNC-4 | Attach 模式下，本机终端中输入的内容与 Agent 输出**实时**出现在手机端；手机发送的消息实时出现在本机 TUI | P1 ⚠️ | 两端延迟 < 1s（局域网），无重复/丢失 |
| SYNC-5 | 手机端可列出/搜索/恢复本机任意历史会话（等价 `/resume`），含会话名、首条消息、时间、消息数 | P0 | 与终端 `/resume` 列表一致 |
| SYNC-6 | 断线重连后**增量补齐**事件，不重复渲染 | P0 | 锁屏 5 分钟后解锁，消息不丢不重 |
| SYNC-8 | **多设备同时登录**（手机 + 平板等）：所有设备同时订阅同一会话并实时同步；任一设备均可发送/中止；显示在线设备与「另一设备正在输入」；通知推送到所有已授权设备 | P0 | 两台设备同时打开同一会话，一端发送，另一端 < 1s 看到完整流式输出；一端中止，另一端状态同步 |
| SYNC-7 | 手机端展示当前持有者状态：`本机 TUI` / `PiLink Host` / `空闲` | P1 | 状态变化 ≤ 2s 反映到 UI |

### 5.2 命令与输入（CMD）——对应问题 1

| ID | 需求 | 优先级 | 验收标准 |
|---|---|---|---|
| CMD-1 | 输入 `/` 弹出**命令面板**（底部抽屉）：模糊搜索、分组（内置 / 扩展 / 提示模板 / 技能）、显示描述与参数提示、最近使用优先 | P0 | 输入 `/sk` 能看到 `/skill:*` 全部技能；点选后自动填入输入框 |
| CMD-2 | **覆盖 Pi 全部命令**：内置命令 + 扩展命令 + 提示模板 + `/skill:name`（覆盖矩阵见附录 A） | P0 | 附录 A 中 P0/P1 命令 100% 可用；P2 命令至少给出明确的降级说明 |
| CMD-3 | 命令列表**动态来自 Pi**（`get_commands`），新增技能/扩展/模板后 reload 即刻出现在菜单 ✅ | P0 | 在 `.pi/skills` 新增技能并 reload，无需改 PiLink 即可出现 |
| CMD-4 | 需要交互的内置命令（`/model`、`/resume`、`/tree`、`/fork`、`/settings` 等）使用**移动端原生交互**（选择器/列表/树视图），而不是文本输入 | P0 | 无需手输任何参数即可完成上述操作 |
| CMD-5 | 支持 `!cmd` / `!!cmd`（执行 bash，后者不进入模型上下文）✅ | P1 | `!!ls` 输出显示但不进入下一轮上下文 |
| CMD-6 | 支持 `@` 文件引用：模糊搜索工作区文件（遵守 `.gitignore`） | P1 | 输入 `@src/ma` 出现候选，点选后插入路径 |
| CMD-7 | Agent 运行中发送消息时，可选 **Steer（插队）** 或 **Follow-up（排队）** ✅ | P0 | 长按发送按钮选择；队列可见、可清空 |
| CMD-8 | 一键 **Abort**，且 Abort 前可恢复被清掉的排队消息到输入框 ✅ | P0 | 点击中止后，排队文本回填输入框 |
| CMD-9 | 支持图片附件（相机/相册/粘贴）✅ | P1 | 图片以 base64 `images` 字段随 prompt 发送 |
| CMD-10 | 扩展 UI 请求（select / confirm / input / editor / notify 等）在手机端以对话框渲染并回传 ✅ | P1 | 带 `ctx.ui.confirm` 的扩展在手机端可弹窗并正确回应 |
| CMD-11 | 快捷操作栏：模型、思考等级、压缩、新会话、树、中止（替代 TUI 快捷键如 `Ctrl+P` / `Shift+Tab`） | P1 | 一次点击完成，无需打字 |

### 5.3 渲染（RND）——对应问题 3

| ID | 需求 | 优先级 | 验收标准 |
|---|---|---|---|
| RND-1 | **流式展示 thinking**（`thinking_delta`），默认折叠、可展开；折叠态显示实时一行预览与耗时 | P0 | 开启思考的模型运行时，手机端可实时看到思考文本增长 |
| RND-2 | Thinking 显示模式可配置：展开 / 折叠 / 隐藏 | P1 | 设置即时生效，且对历史消息同样生效 |
| RND-3 | 流式展示 assistant 文本，Markdown 渲染（代码高亮、表格、列表） | P0 | 长输出滚动流畅（≥ 30fps），不卡顿 |
| RND-4 | 工具调用卡片：工具名、参数摘要、实时输出、状态（运行/成功/失败）；`edit` 类展示 diff | P0 | 点击卡片可展开完整参数/输出；超长输出截断并可按需加载全文 |
| RND-5 | 展示 compaction、auto-retry、队列、上下文使用率（`get_session_stats` 的 contextUsage）等状态 | P1 | 顶栏显示上下文占用环与当前模型/思考等级 |
| RND-6 | 加载历史时同样呈现历史 thinking 与工具调用；provider 不返回可读 thinking 时给出「思考内容不可见」占位 | P1 | 历史会话与实时会话呈现一致 |
| RND-7 | 支持会话树（`/tree`）可视化：分支、当前叶子、标签 | P1 | 可从树中任意用户消息处 fork |

### 5.4 角色提示词选择（ROLE）——对应问题 4

背景（✅ 已核对）：Pi 里 `.pi/SYSTEM.md`（项目）或 `~/.pi/agent/SYSTEM.md`（全局）会**替换**默认系统提示词，项目文件优先于全局；`APPEND_SYSTEM.md` 为追加；项目级文件受「项目信任」约束；修改后需 `/reload`。

| ID | 需求 | 优先级 | 验收标准 |
|---|---|---|---|
| ROLE-1 | 在当前 Workspace 中**发现候选 SYSTEM 文件**：工作区内任意路径的 `SYSTEM.md`、`.pi/roles/*.md`，以及用户手动固定的路径 | P0 | 根目录 `SYSTEM.md` 与 `my-agent/SYSTEM.md` 同时出现在列表中，显示相对路径、标题/首行预览、修改时间 |
| ROLE-2 | 选择器提供「**Pi 默认**」空选项：不使用项目级 SYSTEM 覆盖，回落到全局 SYSTEM.md（若有）或 Pi 内置默认；UI 需明示回落到的是哪一个 | P0 | 选择「默认」后，系统提示词不再包含自定义内容 |
| ROLE-3 | 选定后**自动 reload** 并给出生效确认（展示新提示词的前若干行/哈希）；失败时回滚并提示原因 | P0 | 选择后无需任何手动操作，下一条消息即按新角色回复 |
| ROLE-4 | 选择结果是**工作区级状态**，对本机终端同样生效（因为落在文件系统上），并在顶栏以 Role 徽标常驻显示 | P0 | 手机切换后，本机新开 `pi` 使用同一角色 |
| ROLE-5 | **不得破坏用户已有的 `.pi/SYSTEM.md`**：首次接管时询问「纳入管理」，原文件备份并作为候选项保留 | P0 | 任何操作路径下都不会丢失原文件内容 |
| ROLE-6 | Agent 正在运行时切换角色：必须先等待空闲或确认中止；并提示「已有历史不会重写，提示词缓存将失效」 | P1 | 运行中选择不会导致状态错乱 |
| ROLE-7 | 项目未获信任时，明确提示「项目 SYSTEM.md 未生效」并引导完成信任（`/trust`） | P0 ⚠️ | 未信任项目下不会出现「显示已切换但实际没生效」 |
| ROLE-8 | 支持预览（只读查看全文）与基础编辑/新建（P2） | P2 | — |
| ROLE-9 | 可选：同时选择 `APPEND_SYSTEM.md`（追加型角色片段） | P2 | — |

### 5.5 工作区与会话管理（WS）

| ID | 需求 | 优先级 |
|---|---|---|
| WS-1 | Gateway 配置**工作区白名单**；手机端只能在白名单内选择/切换 cwd | P0 |
| WS-2 | 工作区列表：最近使用、各工作区的会话数、当前持有者状态 | P0 |
| WS-3 | 新建会话、重命名（`/name`）、fork、clone、导出 HTML | P0/P1 |
| WS-4 | 多会话并行：同一时刻可同时托管多个会话（不同 Workspace 或不同 Session），手机端可切换 | P1 |
| WS-5 | 任务完成/需要用户输入时发送**推送通知**（Web Push），发往所有已授权设备 | P1 |
| WS-6 | 设备管理：列出已配对设备（名称、最近在线、IP）、单独吊销；设备数量上限可配置（默认 5） | P0 |

### 5.6 移动端体验（MOB）

| ID | 需求 | 优先级 |
|---|---|---|
| MOB-1 | PWA：可添加到主屏、全屏、安全区适配、深浅色主题 | P0 |
| MOB-2 | 输入框针对手机优化：回车默认换行、显式发送键、草稿自动保存、软键盘弹起不遮挡输入与消息 | P0 |
| MOB-3 | 单手可达：核心操作在屏幕下半区；命令面板为底部抽屉 | P0 |
| MOB-4 | 长列表虚拟化；流式渲染做节流，避免掉帧与发热 | P0 |
| MOB-5 | 弱网：自动重连（指数退避）、心跳、连接状态条、断线期间输入不丢 | P0 |
| MOB-6 | 手势：长按用户消息 → fork / 复制；长按发送 → steer / follow-up | P1 |
| MOB-7 | 语音输入（系统听写即可），不自建 ASR | P2 |
| MOB-8 | 可访问性：动态字体、对比度、VoiceOver 基本可用 | P2 |

### 5.7 远程访问（NET）与安全（SEC）

| ID | 需求 | 优先级 |
|---|---|---|
| NET-1 | Gateway 仅监听 `127.0.0.1`，由 **frpc** 反向代理到阿里云 ECS（frps）；对外经 Nginx 在 **公网 IP + 非标准端口（如 8443）** 上提供 HTTPS + WSS，**无需域名** | P0 |
| NET-5 | **IP 证书**：使用 Let's Encrypt 的 IP 地址证书（short-lived，约 6 天有效）并自动续期；续期失败要在手机端/本机告警；备选为私有 CA 自签证书（需在手机上安装并信任） | P0 ⚠️ |
| NET-6 | 业务端口避开 80/443/8080（阿里云对大陆节点未备案站点有拦截策略）；ACME 验证所需的 80 或 443 仅在签发/续期时临时开放 | P0 ⚠️ |
| NET-2 | 同一份 Web 客户端在 Mac 本机可直接 `http://localhost:<port>` 使用，不依赖公网 | P0 |
| NET-3 | frpc 作为 macOS 常驻服务（launchd）自动重连；Gateway 同样常驻自启 | P1 |
| NET-4 | 提供 `pilink doctor`：检测 Pi 版本、frp 连通性、证书、端口、睡眠设置 | P2 |
| SEC-1 | **强认证**：设备配对（本机终端显示二维码/一次性码）+ **WebCrypto 设备密钥**（不可导出的 ECDSA 私钥，签名挑战）；JWT 短期令牌；支持设备吊销。**不使用 WebAuthn/Passkey**（其 RP ID 不能是 IP 地址，因此在「无域名」方案下不可用） | P0 |
| SEC-2 | 全链路加密：frp 开启 TLS 与 token；公网入口强制 HTTPS/WSS；HSTS | P0 |
| SEC-3 | **远程即等于 Mac 上的任意命令执行**，因此：工作区白名单、操作审计日志、敏感文件（`auth.json` 等）永不下发客户端 | P0 |
| SEC-4 | 速率限制、登录失败锁定、Origin 校验 | P0 |
| SEC-5 | 可选「只读/受限会话」（限制工具集启动）用于低信任场景 | P3（已确认无强需求，v1 不排期） |
| SEC-6 | 日志脱敏（API Key、令牌） | P1 |

---

## 6. 非功能需求

| 类别 | 指标 |
|---|---|
| 性能 | 局域网内首个流式字符延迟增量 ≤ 200ms（相对 Pi 事件）；公网（阿里云中转）≤ 800ms；冷启动到可交互 ≤ 3s |
| 可靠性 | 网络闪断自动恢复；Gateway 崩溃重启后能重新接管/发现会话；不丢失已提交的 Session 数据 |
| 一致性 | 任意时刻 Session 文件只有一个写入者（SYNC-2） |
| 兼容性 | iOS Safari ≥ 16.4（PWA/Push）、Android Chrome 近两个大版本；Pi 1.x |
| 可维护性 | 与 Pi 协议类型共享（`rpc-types.ts`）；Pi 升级后有契约测试提醒不兼容 |
| 安全 | 见 SEC；默认拒绝（default deny） |
| 可观测 | 结构化日志、连接/会话状态面板、审计日志 |
| 电源 | Mac 休眠会导致不可达；提供「保持唤醒」开关与使用说明（合盖需外接电源等条件） |

---

## 7. 约束与已核实的 Pi 能力（设计依据）

以下事实来自 Pi 官方文档（Pi 1.0），是本项目方案成立的基础：

1. ✅ **RPC 模式**：`pi --mode rpc` 通过 stdin/stdout 的 JSONL 协议无头运行；必须以 LF 分帧（不能用 Node `readline`，因其会按 U+2028/2029 误切）。
2. ✅ **RPC 命令**覆盖：`prompt / steer / follow_up / abort / clear_queue / new_session / get_state / get_messages / set_model / cycle_model / get_available_models / set_thinking_level / cycle_thinking_level / get_available_thinking_levels / compact / set_auto_compaction / set_auto_retry / abort_retry / bash / abort_bash / get_session_stats / export_html / switch_session / fork / clone / get_fork_messages / get_entries / get_tree / get_last_assistant_text / set_session_name / get_commands`。
3. ✅ `get_entries` 支持以**条目 id 作为持久游标**（`since`），可跨客户端重启增量同步；会话是追加写的树结构。
4. ✅ **TUI 内置命令不会通过 RPC 提供**（`/settings`、`/hotkeys` 等仅交互模式处理）。`get_commands` 只返回扩展命令、提示模板、技能。⇒ **内置命令必须由 PiLink 自己实现**（这是需求 CMD-2/CMD-4 的主要工作量）。
5. ✅ 扩展 UI（`select/confirm/notify` 等）在 RPC 模式下通过 `extension_ui_request/response` 转发。
6. ✅ SDK 提供 `AgentSessionRuntime`（`newSession/switchSession/fork/importFromJsonl`），但 **SDK 会话默认不加载 CLI 内置的 codemode / tool_search / MCP 扩展**；RPC 子进程与 CLI 行为一致。
7. ✅ `SYSTEM.md` 位置与优先级：项目 `.pi/SYSTEM.md` > 全局 `~/.pi/agent/SYSTEM.md`；项目级文件需项目信任；`/reload` 重新加载键位、扩展、技能、模板、主题与上下文文件。
8. ⚠️ RPC 命令集中**没有** `reload`、会话树「导航到某个节点」、`import`、`trust`、`login/logout`。需要通过 Bridge 扩展或其它手段补齐（见设计文档 §6、§8）。
9. ⚠️ 「本机 TUI 进程 + 远程同时控制同一进程」没有官方现成接口；设计采用 Bridge 扩展方案，能力范围需 Spike 验证。
10. ℹ️ Pi 1.0 同期发布了实验性的 **Pi Durable**（多客户端 attach、可跨进程恢复的 harness）。它是**独立的框架**，并非现有 coding-agent 的会话载体，因此 v1 不依赖；作为远期演进方向在设计文档中记录。

---

## 8. 里程碑

| 阶段 | 内容 | 产出 |
|---|---|---|
| M0 Spike（3–5 天） | 验证 ⚠️ 项：Bridge 扩展能力、reload 路径、trust、tree 导航；**北京 ECS 的 IP 证书签发与手机端 HTTPS 可用性（设计文档 S11）**；多设备并发（S12） | Spike 报告 + 能力矩阵定稿 |
| M1 Host MVP（1–2 周） | Gateway + Host 模式（RPC 子进程）+ Web 客户端；流式/thinking/工具卡片；命令面板与 P0 命令；会话列表与交接；本地访问 | 本机浏览器/手机局域网可用，解决问题 1、2（交接式）、3 |
| M2 Role 与远程（1 周） | SYSTEM 选择器 + 自动 reload；frp + HTTPS + 设备配对与认证；PWA 与推送 | 公网可用，解决问题 4 |
| M3 Attach 实时共享（1–2 周） | Bridge 扩展；本机 TUI 与手机实时共视/共控 | 达成「同时在线」的无缝体验 |
| M4 打磨 | P1/P2 命令、手势、弱网、性能、`pilink doctor` | v1.0 |

---

## 9. 风险与待决问题

| # | 风险/问题 | 影响 | 应对 |
|---|---|---|---|
| R1 | Attach 模式依赖的扩展 API（发送用户消息、会话操作、reload）能力不足 | SYNC-4 无法实现 | M0 Spike；兜底为「交接式」共享（M1 已满足 SYNC-1/2/3） |
| R2 | 用户在本机直接 `pi -c` 恰好与 Host 同时写同一会话 | 上下文分叉 | 锁文件 + Bridge 启动时拦截 + 文件变更监测（设计 §4） |
| R3 | 远程暴露 = 远程代码执行面 | 严重 | SEC 全部 P0 项；默认仅白名单工作区；审计日志 |
| R4 | ECS 在北京、无域名：① 无受信任证书则浏览器不是「安全上下文」，PWA 安装、Service Worker、WebCrypto、Web Push 均不可用；② 阿里云对 80/443/8080 的未备案拦截可能影响 ACME 验证 | 手机端核心能力不可用 | 采用 **Let's Encrypt IP 证书**（NET-5）；Spike 验证在北京 ECS 上能否通过 HTTP-01/TLS-ALPN-01 签发；失败则降级为私有 CA（手机安装信任）或更换为 Tailscale 等私网方案 |
| R9 | IP 证书约 6 天有效，续期失败会导致手机突然无法访问 | 可用性 | 自动续期 + 提前告警 + 到期前 48h 持续重试；保留私有 CA 作为应急 |
| R5 | Mac 休眠/断网导致不可达 | 体验 | 保持唤醒开关；frpc/Gateway 自启；UI 明示离线 |
| R6 | Pi 版本演进导致协议变化 | 维护成本 | 直接复用 `rpc-types.ts` 类型 + 契约测试 + 版本检测 |
| R7 | 部分 provider 的 thinking 内容不可见/被加密 | RND-1 不完整 | 优雅降级占位；显示耗时/token |
| R8 | `/login` OAuth 需要本机浏览器回调 | 手机无法完成 | 标记为「仅本机」，给出引导 |

**已确认的决策（第一轮）**

| # | 问题 | 结论 | 对设计的影响 |
|---|---|---|---|
| 1 | ECS 地域/域名 | 中国北京；**无域名，用公网 IP + 端口访问** | 采用 IP 证书；放弃 Passkey；端口避开 80/443/8080（见 NET-5/6、SEC-1、R4） |
| 2 | 本机使用方式 | **终端直接运行 `pi`，不使用 tmux** | Attach 只能依赖 Bridge 扩展（无法 tmux send-keys 注入）；交接话术围绕「在该终端 `/quit` 后手机托管，回来用 `pi --session <path>` 接回」 |
| 3 | 多设备 | **需要**（手机 + 平板同时登录） | 新增 SYNC-8、WS-6；设计加入多设备在线状态与输入提示 |
| 4 | 只读/受限会话 | 无强需求 | SEC-5 降为 P3，不排期 |
| 5 | 迁移飞书历史 | 不迁移 | 列入非目标 |

**仍待确认**

1. 北京 ECS 的安全组是否允许你临时开放 80 端口用于证书签发？（HTTP-01；若不行，改用 TLS-ALPN-01 走 443，或私有 CA）
2. 手机/平板的系统（iOS / Android）？（影响 PWA 推送与私有 CA 备选方案的安装步骤）
3. 同时在线的设备数大致上限？（默认 5）

---

## 附录 A：Pi 命令覆盖矩阵

> 实现方式说明：**RPC** = 直接映射 RPC 命令；**GW** = Gateway 自行实现；**BR** = 经 Bridge 扩展；**CL** = 纯客户端逻辑。

### A.1 内置斜杠命令（✅ 来自 Pi 官方 Slash commands 文档）

| 命令 | 实现方式 | 移动端交互 | 优先级 |
|---|---|---|---|
| `/model [provider/model]` | RPC `get_available_models` + `set_model` | 底部选择器（按 provider 分组、搜索） | P0 |
| `/thinking [level]` | RPC `get_available_thinking_levels` + `set_thinking_level` | 分段控件，仅显示当前模型支持的等级 | P0 |
| `/new` | RPC `new_session` | 确认后新建 | P0 |
| `/resume` | GW 列会话 + RPC `switch_session` | 会话列表（搜索/按时间） | P0 |
| `/name [name]` | RPC `set_session_name` / `get_state` | 内联编辑 | P0 |
| `/session` | RPC `get_session_stats` + `get_state` | 信息面板 | P0 |
| `/fork` | RPC `get_fork_messages` + `fork` | 选择历史用户消息 | P0 |
| `/clone` | RPC `clone` | 确认 | P1 |
| `/compact [instructions]` | RPC `compact` | 可选输入指令；显示压缩前后 token | P0 |
| `/copy` | RPC `get_last_assistant_text` + CL 剪贴板 | 一键 | P0 |
| `/reload` | BR `reload` ⚠️；兜底 RPC `switch_session`（同一文件） | 按钮 + Role 切换时自动触发 | P0 |
| `/tree` | RPC `get_tree` 只读；切换节点走 BR ⚠️ | 树视图；可从节点 fork | P1 |
| `/export [path]` | RPC `export_html` + GW 下载 | 下载/分享 | P1 |
| `/settings` | GW 读写 `settings.json`（字段白名单） | 设置页 | P1 |
| `/trust` | BR/GW ⚠️ | 引导对话框 | P1 |
| `/quit` | GW 关闭 Host 进程（关闭 stdin） | 「结束托管」 | P1 |
| `/scoped-models` | GW 读写对应 settings 字段 ⚠️ | 多选列表 | P2 |
| `/import <path>` | GW 复制 JSONL 到会话目录 + `switch_session` | 上传/选择文件 | P2 |
| `/share` | ⚠️ 需确认实现路径；涉及外传，强确认 + 脱敏提示 | 强提示 | P2 |
| `/login` `/logout` | 仅本机（OAuth 回调）；Gateway 仅展示登录状态 | 降级说明 | P2 |
| `/llama` | 仅在配置了 llama.cpp router 时显示；GW 代理 | 降级说明 | P2 |
| `/hotkeys` | 替换为「手势/快捷栏帮助」 | 帮助页 | P2 |
| `/changelog` | GW 读取已安装包的 CHANGELOG | 文本页 | P3 |
| `/bug` | 不实现，给出指引 | — | P3 |

### A.2 动态命令（✅ `get_commands`）

| 类型 | 调用方式 | 优先级 |
|---|---|---|
| 扩展命令 `/mycommand` | `prompt`（即使在流式中也立即执行） | P0 |
| 提示模板 `/template` | `prompt`（Pi 侧展开） | P0 |
| 技能 `/skill:name` | `prompt`（Pi 侧展开） | P0 |

### A.3 输入语法与 TUI 快捷键等价物

| TUI 能力 | PiLink 等价 | 优先级 |
|---|---|---|
| `!cmd` / `!!cmd` | RPC `bash`（`excludeFromContext`） | P1 |
| `@file` | GW 文件搜索 | P1 |
| Enter / 排队键（steer / follow-up） | 长按发送键二选一 | P0 |
| Esc（中止） | 中止按钮：`clear_queue` → `abort` | P0 |
| 循环切换模型 / 思考等级 | 快捷栏 `cycle_model` / `cycle_thinking_level` | P1 |
| 图片粘贴 | 附件按钮，`images` 字段 | P1 |

---

## 附录 B：验收用例（节选）

| 编号 | 用例 | 期望 |
|---|---|---|
| AC-1 | 终端 `pi` 对话 → 释放 → 手机打开同一会话 | 历史一致，可继续对话，终端 `pi -c` 再接回后看到手机内容 |
| AC-2 | Host 托管期间，终端尝试 `pi -c` 同一会话（装有 Bridge） | 提示冲突并给出「接管」选项；不发生双写 |
| AC-3 | 手机输入 `/` | 1 帧内弹出命令面板，含内置 + 动态命令 |
| AC-4 | 使用 thinking 模型执行复杂任务 | 实时看到 thinking 流；完成后折叠，历史可展开 |
| AC-5 | 选择 `my-agent/SYSTEM.md` 为角色 | 自动 reload；顶栏 Role 徽标更新；下一条回复体现新角色；终端新开 `pi` 同样生效 |
| AC-6 | 选择「Pi 默认」 | 项目级覆盖移除；回落说明正确；原 `.pi/SYSTEM.md`（如有）已备份可恢复 |
| AC-7 | 运行中锁屏 5 分钟后解锁 | 自动重连并补齐事件，无重复 |
| AC-8 | 未配对设备直接访问公网地址 | 拒绝；不泄露任何会话信息 |
| AC-9 | 公网下手机连续 Abort / Steer | 响应 < 1s，状态正确 |
