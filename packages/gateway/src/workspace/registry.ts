/**
 * 工作区注册表（WS-1/WS-2）：白名单 + 最近使用 + Pi 会话目录映射。
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Store } from "../db.js";

export function piSessionsRoot(): string {
  return join(process.env.PI_AGENT_DIR ?? join(homedir(), ".pi"), "agent", "sessions");
}

export function encodeWorkspaceId(cwd: string): string {
  return Buffer.from(cwd, "utf8").toString("base64url");
}
export function decodeWorkspaceId(id: string): string {
  return Buffer.from(id, "base64url").toString("utf8");
}

/** Pi 的会话目录命名：去掉前导 /，将 / \ : 替换为 - */
export function piDirNameForCwd(cwd: string): string {
  return cwd.replace(/^[/\\]+/, "").replace(/[/\\:]/g, "-");
}

export class WorkspaceRegistry {
  constructor(
    private whitelist: string[],
    private store: Store,
  ) {}

  /** cwd 是否在白名单（WS-1；白名单为空时允许任意已登记过的最近工作区） */
  isAllowed(cwd: string): boolean {
    if (this.whitelist.some((w) => cwd === w || cwd.startsWith(w.replace(/\/$/, "") + "/"))) return true;
    if (this.whitelist.length === 0) {
      const recent = this.store.listRecentWorkspaces();
      return recent.some((r) => r.cwd === cwd);
    }
    return false;
  }

  touch(cwd: string): string {
    const id = encodeWorkspaceId(cwd);
    this.store.touchWorkspace(id, cwd);
    return id;
  }

  list(): { workspaceId: string; cwd: string; lastUsedAt: number; sessionCount: number; allowed: boolean }[] {
    const recents = this.store.listRecentWorkspaces();
    const fromWhitelist = this.whitelist
      .filter((w) => !recents.some((r) => r.cwd === w))
      .map((cwd) => ({ workspaceId: encodeWorkspaceId(cwd), cwd, lastUsedAt: 0 }));
    return [...recents, ...fromWhitelist].map((r) => ({
      ...r,
      sessionCount: countSessionsForCwd(r.cwd),
      allowed: this.isAllowed(r.cwd),
    }));
  }
}

export function countSessionsForCwd(cwd: string): number {
  const dir = join(piSessionsRoot(), `--${piDirNameForCwd(cwd)}--`);
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).length;
  } catch {
    return 0;
  }
}
