/**
 * 全局状态（Zustand）：连接、会话、流式消息、UI。
 */
import { create } from "zustand";
import type { SessionKey, PiEvent, GatewayEvent, ServerMsg } from "@pilink/protocol";
import { StreamState, type UiMessage } from "./model";
import { client, clearAuth } from "./client";

export type ThinkingMode = "expanded" | "collapsed" | "hidden";

export interface WorkspaceInfo {
  workspaceId: string;
  cwd: string;
  lastUsedAt: number;
  sessionCount: number;
  allowed: boolean;
}
export interface SessionSummary {
  sessionId: string;
  path: string;
  cwd: string;
  name?: string;
  preview?: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}
export interface DeviceInfo {
  deviceId: string;
  name: string;
  pairedAt: number;
  lastSeenAt: number;
  lastIp?: string;
  revoked: boolean;
  online: boolean;
}
export interface RoleCandidate {
  source: string;
  title: string;
  /** 用户配置的别名（.pi/roles.json），展示优先 */
  alias?: string;
  preview: string;
  size: number;
  mtime: number;
  native: boolean;
  current: boolean;
}
export interface UiRequestItem {
  sessionKey: SessionKey;
  requestId: string;
  payload: any;
}

interface AppState {
  conn: "connecting" | "online" | "offline";
  tab: "chat" | "settings";
  /** Sidebar 展开状态（桌面：显隐；移动端：抽屉滑入滑出） */
  sidebarOpen: boolean;
  /** workspaceId → 用户自定义别名（localStorage 持久化，本设备生效） */
  workspaceAliases: Record<string, string>;
  serverVersion?: string;
  piVersion?: string;

  workspaces: WorkspaceInfo[];
  workspaceId?: string;
  cwd?: string;
  sessions: SessionSummary[];

  sessionKey?: SessionKey;
  sessionPath?: string;
  /** 正在打开会话（session.open + 历史加载期间），主页面显示 loading */
  sessionLoading?: boolean;
  holder?: "host" | "tui" | "none";
  hostStatus?: string;
  conflict?: string;
  presence: { deviceId: string; name: string; typing: boolean }[];

  stream: StreamState;
  isStreaming: boolean;
  isCompacting: boolean;
  queue: { steering: string[]; followUp: string[] };
  model?: { provider: string; id: string; name?: string };
  thinkingLevel?: string;
  contextUsage?: { tokens: number | null; contextWindow: number | null; percent: number | null };
  sessionName?: string;
  stats?: Record<string, unknown>;

  thinkingMode: ThinkingMode;
  devices: DeviceInfo[];
  roles: RoleCandidate[];
  roleCurrent?: string | null;
  roleFallback?: { kind: "global" | "builtin"; path?: string };
  commands: { builtin: unknown[]; dynamic: unknown[] };
  uiRequests: UiRequestItem[];

  set: (p: Partial<AppState>) => void;
  connect: () => void;
  logout: () => void;
  /** 会话新鲜度校准（L4）：比对最后条目 id，落后则全量重载历史 */
  syncIfStale: () => Promise<void>;
  /** 手动重载历史并清除冲突标记（冲突横幅按钮） */
  reloadHistory: () => Promise<void>;
  /** 进入工作区并自动打开最近会话（无会话则新建） */
  enterWorkspace: (workspaceId: string, cwd: string) => Promise<void>;
  /** 启动恢复：默认加载最近使用的 workspace → 最近 session */
  restoreMostRecent: () => Promise<void>;
  setWorkspaceAlias: (workspaceId: string, alias: string) => void;
  selectWorkspace: (workspaceId: string, cwd: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
  openSession: (sessionPath: string) => Promise<void>;
  releaseSession: () => Promise<void>;
  newSession: () => Promise<void>;
  loadHistory: () => Promise<void>;
  refreshState: () => Promise<void>;
  refreshStats: () => Promise<void>;
  refreshCommands: () => Promise<void>;
  refreshRoles: () => Promise<void>;
  selectRole: (source: string | null, force?: boolean) => Promise<void>;
  refreshDevices: () => Promise<void>;
  refreshWorkspaces: () => Promise<void>;
  sendPrompt: (text: string, images?: { data: string; mimeType: string }[], behavior?: "steer" | "followUp") => Promise<void>;
  runBash: (command: string, excludeFromContext: boolean) => Promise<void>;
  abort: () => Promise<void>;
  clearQueue: () => Promise<{ steering: string[]; followUp: string[] } | null>;
}

export const useApp = create<AppState>((set, get) => {
  let lastSeq = 0;
  let lastEntryId: string | undefined;

  client.onStatusChange = (conn) => set({ conn });

  client.onMessage = (msg: ServerMsg) => {
    const s = get();
    switch (msg.t) {
      case "hello_ok":
        set({ serverVersion: msg.serverVersion, piVersion: msg.piVersion });
        break;
      case "event": {
        if (msg.sessionKey !== s.sessionKey) break;
        lastSeq = msg.seq;
        const stream = s.stream;
        stream.applyEvent(msg.ev);
        const ev = msg.ev as Record<string, any>;
        if (ev.type === "agent_settled") set({ isStreaming: false });
        if (ev.type === "agent_start") set({ isStreaming: true });
        if (ev.type === "message_end" && ev.message?.role === "assistant") {
          // 空闲检测辅助：isStreaming 以 get_state 校准
        }
        set({ stream });
        break;
      }
      case "gw_res": {
        // 增量补齐失败（缓冲溢出）→ 全量历史校准（L3）
        if (!msg.ok && msg.error?.code === "RESYNC_REQUIRED" && s.sessionKey) {
          void get()
            .loadHistory()
            .then(() => set({ conflict: undefined }))
            .catch(() => {});
        }
        break;
      }
      case "gw_event": {
        const ev = msg.ev as GatewayEvent;
        if (ev.e === "holder_changed" && ev.sessionKey === s.sessionKey) set({ holder: ev.holder });
        if (ev.e === "host_status" && ev.sessionKey === s.sessionKey) set({ hostStatus: ev.status });
        if (ev.e === "conflict" && ev.sessionKey === s.sessionKey)
          set({ conflict: ev.reason === "external_write" ? "检测到本机其它进程写入此会话" : "事件缓冲失效，需要重新同步" });
        if (ev.e === "presence" && ev.sessionKey === s.sessionKey) set({ presence: ev.devices });
        if (ev.e === "role_changed") void get().refreshRoles();
        break;
      }
      case "ui_request": {
        set({ uiRequests: [...s.uiRequests, { sessionKey: msg.sessionKey, requestId: msg.requestId, payload: msg.payload }] });
        break;
      }
    }
  };

  return {
    conn: "offline",
    tab: "chat",
    sidebarOpen:
      localStorage.getItem("pilink.sidebarOpen") === null
        ? typeof window !== "undefined" && window.innerWidth >= 700
        : localStorage.getItem("pilink.sidebarOpen") === "1",
    workspaceAliases: (() => {
      try {
        return JSON.parse(localStorage.getItem("pilink.wsAliases") ?? "{}") as Record<string, string>;
      } catch {
        return {};
      }
    })(),
    workspaces: [],
    sessions: [],
    stream: new StreamState(),
    isStreaming: false,
    isCompacting: false,
    queue: { steering: [], followUp: [] },
    thinkingMode: (localStorage.getItem("pilink.thinkingMode") as ThinkingMode) || "collapsed",
    devices: [],
    roles: [],
    commands: { builtin: [], dynamic: [] },
    presence: [],
    uiRequests: [],

    set: (p) => {
      if (p.thinkingMode) localStorage.setItem("pilink.thinkingMode", p.thinkingMode);
      if (p.sidebarOpen !== undefined) localStorage.setItem("pilink.sidebarOpen", p.sidebarOpen ? "1" : "0");
      set(p);
    },

    setWorkspaceAlias: (workspaceId, alias) => {
      const aliases = { ...get().workspaceAliases };
      if (alias.trim()) aliases[workspaceId] = alias.trim();
      else delete aliases[workspaceId];
      localStorage.setItem("pilink.wsAliases", JSON.stringify(aliases));
      set({ workspaceAliases: aliases });
      // 同步到服务端（全量覆盖），供其它设备拉取
      void client.gw({ op: "workspace.aliases.set", aliases }).catch((e) => console.warn("别名同步失败：", e));
    },

    connect: () => {
      const s = get();
      const resume =
        s.sessionKey && lastSeq > 0
          ? { sessionKey: s.sessionKey, lastSeq, lastEntryId }
          : undefined;
      void client.connect(resume);
    },

    logout: () => {
      client.disconnect();
      clearAuth();
      location.reload();
    },

    selectWorkspace: async (workspaceId, cwd) => {
      set({ workspaceId, cwd, sessions: [], sessionKey: undefined, stream: new StreamState() });
      await get().refreshSessions();
      await get().refreshRoles();
    },

    enterWorkspace: async (workspaceId, cwd) => {
      await get().selectWorkspace(workspaceId, cwd);
      // 默认加载最近使用的会话；不存在则新建
      const latest = [...get().sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      try {
        if (latest) await get().openSession(latest.path);
        else await get().openSession("new");
      } catch (e) {
        console.error("自动打开会话失败：", e);
      }
    },

    restoreMostRecent: async () => {
      if (get().workspaceId) return; // 已有选择（不覆盖用户手动选择）
      await get().refreshWorkspaces();
      const ws = [...get().workspaces].sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0];
      if (ws) await get().enterWorkspace(ws.workspaceId, ws.cwd);
    },

    syncIfStale: async () => {
      const { sessionKey, sessionLoading, conn } = get();
      if (!sessionKey || sessionLoading || conn !== "online") return;
      const res = await client.rpc(sessionKey, { type: "get_entries" } as never).catch(() => null);
      if (!res?.success) return;
      const list = (res.data as { entries: { id: string }[] }).entries;
      const remoteLeaf = list[list.length - 1]?.id;
      if (remoteLeaf && remoteLeaf !== lastEntryId) await get().loadHistory();
    },

    reloadHistory: async () => {
      await get().loadHistory();
      set({ conflict: undefined });
    },

    refreshWorkspaces: async () => {
      const res = await client.gw<{ workspaces: WorkspaceInfo[]; aliases?: Record<string, string> }>({ op: "workspaces.list" });
      set({ workspaces: res.workspaces });
      // 别名跨设备同步：服务端为准合并本地缓存；服务端为空且本地有旧数据时自动上行迁移
      const local = get().workspaceAliases;
      const server = res.aliases ?? {};
      if (Object.keys(server).length === 0 && Object.keys(local).length > 0) {
        void client.gw({ op: "workspace.aliases.set", aliases: local }).catch(() => {});
      }
      const merged = { ...local, ...server };
      if (JSON.stringify(merged) !== JSON.stringify(local)) {
        localStorage.setItem("pilink.wsAliases", JSON.stringify(merged));
        set({ workspaceAliases: merged });
      }
    },

    refreshSessions: async () => {
      const { workspaceId } = get();
      if (!workspaceId) return;
      const res = await client.gw<{ sessions: SessionSummary[] }>({ op: "sessions.list", workspaceId });
      // 按最后使用时间倒序（服务端已排序，这里防御性再排一次）
      set({ sessions: res.sessions.sort((a, b) => b.updatedAt - a.updatedAt) });
    },

    openSession: async (sessionPath) => {
      const { workspaceId } = get();
      if (!workspaceId) throw new Error("请先选择工作区");
      // 立即进入 loading：session.open 可能耗时（spawn pi 进程 + 历史回放）
      set({ sessionLoading: true, conflict: undefined });
      try {
        const res = await client.gw<{ sessionKey: SessionKey; holder: "host" | "tui"; sessionPath?: string; reused?: boolean }>({
          op: "session.open",
          workspaceId,
          sessionPath,
        });
        lastSeq = 0;
        set({ sessionKey: res.sessionKey, sessionPath: res.sessionPath ?? sessionPath, holder: res.holder, conflict: undefined, tab: "chat" });
        await get().loadHistory();
        await get().refreshState();
        await get().refreshCommands();
        client.setTyping(res.sessionKey, false);
      } finally {
        set({ sessionLoading: false });
      }
    },

    releaseSession: async () => {
      const { sessionKey } = get();
      if (!sessionKey) return;
      await client.gw<{ released: boolean; resumeCommand?: string }>({ op: "session.release", sessionKey });
      lastSeq = 0;
      set({ sessionKey: undefined, holder: "none", stream: new StreamState(), isStreaming: false });
    },

    newSession: async () => {
      const res = await client.rpc(get().sessionKey!, { type: "new_session" } as never);
      if (res.success) {
        lastSeq = 0;
        set({ stream: new StreamState(), conflict: undefined });
        await get().refreshState();
        await get().refreshSessions();
      }
    },

    loadHistory: async () => {
      const { sessionKey } = get();
      if (!sessionKey) return;
      const res = await client.rpc(sessionKey, { type: "get_messages" } as never);
      if (res.success) {
        const msgs = (res.data as { messages: Record<string, any>[] }).messages;
        set({ stream: StreamState.fromHistory(msgs) });
      }
      // 条目游标（SYNC-6）：取最后一条 entry id
      const entries = await client.rpc(sessionKey, { type: "get_entries" } as never);
      if (entries.success) {
        const list = (entries.data as { entries: { id: string }[] }).entries;
        lastEntryId = list[list.length - 1]?.id;
      }
    },

    refreshState: async () => {
      const { sessionKey } = get();
      if (!sessionKey) return;
      const res = await client.rpc(sessionKey, { type: "get_state" } as never);
      if (!res.success) return;
      const d = res.data as Record<string, any>;
      set({
        isStreaming: !!d.isStreaming,
        isCompacting: !!d.isCompacting,
        model: d.model ? { provider: d.model.provider, id: d.model.id, name: d.model.name } : undefined,
        thinkingLevel: d.thinkingLevel,
        sessionName: d.sessionName,
        sessionPath: d.sessionFile,
      });
      void get().refreshStats();
    },

    refreshStats: async () => {
      const { sessionKey } = get();
      if (!sessionKey) return;
      const res = await client.rpc(sessionKey, { type: "get_session_stats" } as never);
      if (res.success) {
        const d = res.data as Record<string, any>;
        set({ stats: d, contextUsage: d.contextUsage });
      }
    },

    refreshCommands: async () => {
      const { sessionKey } = get();
      if (!sessionKey) return;
      const res = await client.gw<{ builtin: unknown[]; dynamic: unknown[] }>({ op: "commands.list", sessionKey });
      set({ commands: { builtin: res.builtin, dynamic: res.dynamic } });
    },

    refreshRoles: async () => {
      const { workspaceId } = get();
      if (!workspaceId) return;
      const res = await client.gw<{ candidates: RoleCandidate[]; current: string | null; fallback: { kind: "global" | "builtin"; path?: string } }>({
        op: "roles.list",
        workspaceId,
      });
      set({ roles: res.candidates, roleCurrent: res.current, roleFallback: res.fallback });
    },

    selectRole: async (source, force) => {
      const { workspaceId, isStreaming } = get();
      if (!workspaceId) return;
      if (isStreaming && !force) throw new Error("Agent 正在运行，请先等待空闲或选择中止后切换");
      const res = await client.gw<{ source: string | null; promptHash?: string; warning?: string }>({
        op: "roles.select",
        workspaceId,
        source,
        force,
      });
      if (res.warning) alert(res.warning);
      await get().refreshRoles();
      await get().refreshState();
    },

    refreshDevices: async () => {
      const res = await client.gw<{ devices: DeviceInfo[] }>({ op: "devices.list" });
      set({ devices: res.devices });
    },

    sendPrompt: async (text, images, behavior) => {
      const { sessionKey, isStreaming } = get();
      if (!sessionKey) throw new Error("会话未打开");
      const cmd = isStreaming
        ? behavior === "steer"
          ? ({ type: "steer", message: text, images } as never)
          : ({ type: "follow_up", message: text, images } as never)
        : ({ type: "prompt", message: text, images } as never);
      const res = await client.rpc(sessionKey, cmd);
      if (!res.success) {
        const err = (res as { error?: string }).error ?? "发送失败";
        // 运行中未指定 behavior 时服务端会报错 → 提示用户选择
        if (isStreaming) throw new Error(`${err}（请长按发送键选择 Steer 或 Follow-up）`);
        throw new Error(err);
      }
      set({ isStreaming: true });
    },

    runBash: async (command, excludeFromContext) => {
      const { sessionKey } = get();
      if (!sessionKey) throw new Error("会话未打开");
      const res = await client.rpc(sessionKey, { type: "bash", command, excludeFromContext } as never);
      if (!res.success) throw new Error((res as { error?: string }).error ?? "执行失败");
    },

    abort: async () => {
      const { sessionKey } = get();
      if (!sessionKey) return;
      await client.rpc(sessionKey, { type: "clear_queue" } as never);
      await client.rpc(sessionKey, { type: "abort" } as never);
      set({ isStreaming: false });
    },

    clearQueue: async () => {
      const { sessionKey } = get();
      if (!sessionKey) return null;
      const res = await client.rpc(sessionKey, { type: "clear_queue" } as never);
      if (res.success) {
        const d = res.data as { steering: string[]; followUp: string[] };
        set({ queue: { steering: d.steering, followUp: d.followUp } });
        return d;
      }
      return null;
    },
  };
});
