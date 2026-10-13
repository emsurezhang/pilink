/**
 * 会话单写者租约（设计文档 §4.2）。
 * 锁文件：`<session>.jsonl` 同目录 `<session>.pilink.lock`。
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";

export type LeaseHolder = "host" | "tui";

export interface LeaseInfo {
  holder: LeaseHolder;
  pid: number;
  gatewayId?: string;
  startedAt: number;
  heartbeatAt: number;
}

export const LEASE_STALE_MS = 20_000;

export function leasePath(sessionPath: string): string {
  return sessionPath.replace(/\.jsonl$/, "") + ".pilink.lock";
}

export function readLease(sessionPath: string): LeaseInfo | null {
  const p = leasePath(sessionPath);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as LeaseInfo;
  } catch {
    return null;
  }
}

export function isLeaseStale(lease: LeaseInfo): boolean {
  return Date.now() - lease.heartbeatAt > LEASE_STALE_MS;
}

/** pid 是否存活（本机校验；跨进程仅靠心跳+陈旧判定兜底） */
function pidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeAtomic(path: string, data: string): void {
  const tmp = path + `.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export class LeaseManager {
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private held = new Map<string, LeaseInfo>();

  /** 尝试获取租约；被非陈旧的其他持有者占用时返回 false。 */
  acquire(sessionPath: string, holder: LeaseHolder, gatewayId?: string): boolean {
    const existing = readLease(sessionPath);
    if (existing && !isLeaseStale(existing)) {
      const mine = this.held.get(sessionPath);
      if (!mine || existing.pid !== mine.pid) return false;
    }
    const info: LeaseInfo = {
      holder,
      pid: process.pid,
      gatewayId,
      startedAt: existing?.startedAt ?? Date.now(),
      heartbeatAt: Date.now(),
    };
    this.held.set(sessionPath, info);
    this.write(sessionPath, info);
    if (!this.timers.has(sessionPath)) {
      this.timers.set(
        sessionPath,
        setInterval(() => {
          const cur = this.held.get(sessionPath);
          if (!cur) return;
          cur.heartbeatAt = Date.now();
          try {
            this.write(sessionPath, cur);
          } catch {
            /* 目录被清理等异常：心跳失败最终由 stale 判定兜底 */
          }
        }, 5_000),
      );
    }
    return true;
  }

  /** 本机 TUI（Bridge）是否持有 */
  isHeldByTui(sessionPath: string): boolean {
    const lease = readLease(sessionPath);
    return !!lease && lease.holder === "tui" && !isLeaseStale(lease) && pidAlive(lease.pid);
  }

  /** 是否由本 Gateway 的 Host 持有 */
  isHeldByHost(sessionPath: string): boolean {
    return this.held.has(sessionPath);
  }

  release(sessionPath: string): void {
    const timer = this.timers.get(sessionPath);
    if (timer) clearInterval(timer);
    this.timers.delete(sessionPath);
    this.held.delete(sessionPath);
    try {
      if (existsSync(leasePath(sessionPath))) unlinkSync(leasePath(sessionPath));
    } catch {
      /* 忽略 */
    }
  }

  /** 抢占陈旧租约（并校验 pid 是否存活，设计 §4.2） */
  stealIfStale(sessionPath: string, holder: LeaseHolder, gatewayId?: string): boolean {
    const existing = readLease(sessionPath);
    if (existing && !isLeaseStale(existing) && pidAlive(existing.pid)) return false;
    this.release(sessionPath);
    return this.acquire(sessionPath, holder, gatewayId);
  }

  releaseAll(): void {
    for (const key of [...this.held.keys()]) this.release(key);
  }

  private write(sessionPath: string, info: LeaseInfo): void {
    writeAtomic(leasePath(sessionPath), JSON.stringify(info));
  }
}

/** 会话 JSONL 同目录的父目录（Pi 布局：~/.pi/agent/sessions/--path--/*.jsonl） */
export function sessionDirForWorkspace(piSessionsRoot: string, workspaceDirName: string): string {
  return join(piSessionsRoot, `--${workspaceDirName}--`);
}
