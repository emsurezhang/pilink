/**
 * PiDriver 抽象（设计文档 §3）：屏蔽「谁持有会话」的差异。
 */
import type { RpcCommand, RpcResponse, PiEvent, SessionKey } from "@pilink/protocol";

export type DriverKind = "host" | "attach";

/** ws 兼容接口（避免 @types/ws 与 Node 24 全局 WebSocket 类型冲突） */
export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: string, listener: (...args: any[]) => void): void;
}

export interface DriverCaps {
  reload: boolean;
  getSystemPrompt: boolean;
  navigateTree: boolean;
  liveCoPresence: boolean;
}

export interface PiDriver {
  readonly kind: DriverKind;
  readonly sessionKey: SessionKey;
  /** 发送 Pi RPC 命令（Attach 模式下由 Bridge 翻译） */
  request(cmd: RpcCommand, signal?: AbortSignal): Promise<RpcResponse>;
  /** 订阅 Pi 事件 */
  onEvent(fn: (ev: PiEvent) => void): () => void;
  readonly caps: DriverCaps;
  /** 当前 Pi 系统提示词（caps.getSystemPrompt 为 true 时可用） */
  getSystemPrompt?(): Promise<string | undefined>;
  /** 触发等价 /reload（caps.reload 为 true 时可用） */
  reload?(): Promise<void>;
  /** 释放：Host=优雅退出；Attach=断开 Bridge（不影响 TUI 进程） */
  release(): Promise<void>;
  /** 进程/桥是否仍然存活 */
  isAlive(): boolean;
}

export class DriverError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
