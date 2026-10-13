/**
 * Role（SYSTEM.md）选择器（设计文档 §8，D6）。
 * 原理：不改 Pi，只管理 `<workspace>/.pi/SYSTEM.md` 受管符号链接，使其指向所选文件。
 */
import { existsSync, lstatSync, readFileSync, writeFileSync, renameSync, symlinkSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { DriverError } from "../driver/types.js";
import type { PiDriver } from "../driver/types.js";

export interface RoleCandidate {
  /** 工作区相对路径（"Pi 默认" 项 source 为 null） */
  source: string;
  absPath: string;
  title: string;
  preview: string;
  size: number;
  mtime: number;
  native: boolean; // 文件本身就是 .pi/SYSTEM.md
  current: boolean;
}

export interface RoleState {
  source: string | null;
  managed: boolean;
  backup?: string;
}

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "coverage", "vendor"]);
const MAX_DEPTH = 4;
const PREVIEW_LINES = 3;

function readTitleAndPreview(absPath: string): { title: string; preview: string } {
  try {
    const head = readFileSync(absPath, "utf8").split("\n").slice(0, 20);
    let title = "";
    let start = 0;
    for (let i = 0; i < head.length; i++) {
      const m = head[i].match(/^#\s+(.+)/);
      if (m) {
        title = m[1].trim();
        start = i + 1;
        break;
      }
    }
    const body = head.slice(start).filter((l) => l.trim()).slice(0, PREVIEW_LINES).join("\n");
    return { title: title || body.split("\n")[0]?.slice(0, 60) || "(空文件)", preview: body.slice(0, 200) };
  } catch {
    return { title: "(无法读取)", preview: "" };
  }
}

export class RoleManager {
  constructor() {}

  private piDir(cwd: string) {
    return join(cwd, ".pi");
  }
  private managedLink(cwd: string) {
    return join(cwd, ".pi", "SYSTEM.md");
  }
  private stateFile(cwd: string) {
    return join(cwd, ".pi", "pilink.json");
  }

  loadState(cwd: string): RoleState {
    try {
      if (existsSync(this.stateFile(cwd))) {
        const j = JSON.parse(readFileSync(this.stateFile(cwd), "utf8"));
        return j.role ?? { source: null, managed: false };
      }
    } catch {
      /* fallthrough */
    }
    return { source: null, managed: false };
  }

  private saveState(cwd: string, role: RoleState): void {
    const p = this.stateFile(cwd);
    let j: Record<string, unknown> = {};
    try {
      if (existsSync(p)) j = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      /* ignore */
    }
    j.role = role;
    writeFileSync(p, JSON.stringify(j, null, 2));
  }

  /** 当前生效源：受管链接指向 / 原生文件 / null */
  currentSource(cwd: string): string | null {
    const link = this.managedLink(cwd);
    if (!existsSync(link)) return null;
    try {
      if (lstatSync(link).isSymbolicLink()) {
        const target = resolve(this.piDir(cwd), readlinkSyncSafe(link));
        const rel = relative(cwd, target);
        return rel.startsWith("..") ? null : rel;
      }
      return ".pi/SYSTEM.md"; // 原生文件
    } catch {
      return null;
    }
  }

  /** ROLE-1：候选发现 */
  listCandidates(cwd: string): RoleCandidate[] {
    const found = new Map<string, string>(); // source -> absPath
    const walk = (dir: string, depth: number): void => {
      if (depth > MAX_DEPTH) return;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        if (IGNORE_DIRS.has(name)) continue;
        const full = join(dir, name);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) walk(full, depth + 1);
        else if (st.isFile() && name === "SYSTEM.md") {
          const rel = relative(cwd, full);
          if (!found.has(rel)) found.set(rel, full);
        }
      }
    };
    walk(cwd, 0);

    // .pi/roles/*.md（推荐集中存放处）
    const rolesDir = join(cwd, ".pi", "roles");
    if (existsSync(rolesDir)) {
      for (const f of readdirSync(rolesDir)) {
        if (f.endsWith(".md")) {
          const rel = relative(cwd, join(rolesDir, f));
          if (!found.has(rel)) found.set(rel, join(rolesDir, f));
        }
      }
    }

    const state = this.loadState(cwd);
    const current = this.currentSource(cwd);
    const out: RoleCandidate[] = [];
    for (const [source, absPath] of [...found.entries()].sort()) {
      const { title, preview } = readTitleAndPreview(absPath);
      let st;
      try {
        st = statSync(absPath);
      } catch {
        continue;
      }
      out.push({
        source,
        absPath,
        title,
        preview,
        size: st.size,
        mtime: st.mtimeMs,
        native: source === ".pi/SYSTEM.md",
        current: current === source,
      });
    }
    return out;
  }

  /** 默认回落说明（ROLE-2 / §8.4） */
  defaultFallbackInfo(): { kind: "global" | "builtin"; path?: string } {
    const global = join(homedir(), ".pi", "agent", "SYSTEM.md");
    if (existsSync(global)) return { kind: "global", path: global };
    return { kind: "builtin" };
  }

  preview(cwd: string, source: string, maxChars = 8000): string {
    const abs = resolve(cwd, source);
    if (!abs.startsWith(resolve(cwd))) throw new DriverError("ROLE_INVALID", "路径越界");
    try {
      return readFileSync(abs, "utf8").slice(0, maxChars);
    } catch {
      throw new DriverError("ROLE_NOT_FOUND", "无法读取文件");
    }
  }

  /**
   * ROLE-3/4/5：选择角色 + 自动 reload（§8.5）。
   * source = null 表示「Pi 默认」。
   */
  async select(cwd: string, source: string | null, driver: PiDriver | null, opts: { force?: boolean } = {}): Promise<{
    source: string | null;
    promptHash?: string;
    fallback?: { kind: "global" | "builtin"; path?: string };
    warning?: string;
  }> {
    const state = this.loadState(cwd);
    const link = this.managedLink(cwd);
    const prevSource = this.currentSource(cwd);

    // ROLE-6：运行中切换需确认
    if (driver && !opts.force) {
      try {
        const st = (await driver.request({ type: "get_state" } as never)) as {
          success: boolean;
          data?: { isStreaming?: boolean };
        };
        if (st.success && st.data?.isStreaming) {
          throw new DriverError("ROLE_BUSY", "Agent 正在运行：请选择「等待空闲后切换」或「中止后切换」");
        }
      } catch (e) {
        if (e instanceof DriverError && e.code === "ROLE_BUSY") throw e;
      }
    }

    // 1. 若 .pi/SYSTEM.md 存在且不是受管链接 → 备份（ROLE-5）
    let backup: string | undefined = state.backup;
    if (existsSync(link) && !lstatSync(link).isSymbolicLink()) {
      const backupRel = ".pi/roles/_original.SYSTEM.md";
      const backupAbs = join(cwd, backupRel);
      if (!existsSync(backupAbs)) {
        mkdirpSync(join(cwd, ".pi", "roles"));
        renameSync(link, backupAbs);
      }
      backup = backupRel;
    }

    // 2. 原子替换链接 / 删除链接
    if (source === null) {
      // 「Pi 默认」：移除项目级覆盖
      if (existsSync(link)) {
        if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
        else {
          const backupRel = ".pi/roles/_original.SYSTEM.md";
          const backupAbs = join(cwd, backupRel);
          if (!existsSync(backupAbs)) {
            mkdirpSync(join(cwd, ".pi", "roles"));
            renameSync(link, backupAbs);
          }
          backup = backupRel;
        }
      }
    } else {
      const abs = resolve(cwd, source);
      if (!abs.startsWith(resolve(cwd))) throw new DriverError("ROLE_INVALID", "路径越界");
      if (!existsSync(abs)) throw new DriverError("ROLE_NOT_FOUND", `文件不存在：${source}`);
      mkdirpSync(this.piDir(cwd));
      const tmp = link + `.tmp-${process.pid}`;
      try {
        unlinkSync(tmp);
      } catch {
        /* no-op */
      }
      if (source === ".pi/SYSTEM.md") {
        // 原生文件：不做链接
      } else {
        symlinkSync(relative(this.piDir(cwd), abs), tmp);
        renameSync(tmp, link);
      }
    }

    // 3. 失败回滚准备：先保存旧状态
    const rollback = (): void => {
      try {
        if (prevSource === null) {
          if (existsSync(link)) unlinkSync(link);
        } else if (prevSource !== ".pi/SYSTEM.md") {
          symlinkSync(relative(this.piDir(cwd), resolve(cwd, prevSource)), link);
        }
        this.saveState(cwd, state);
      } catch {
        /* 尽力回滚 */
      }
    };

    // 4. 持久化新状态
    this.saveState(cwd, { source, managed: source !== null, backup });

    // 5. reload（§8.5：Bridge 可用走 reload；兜底 switch_session 同文件）
    let promptHash: string | undefined;
    let warning: string | undefined;
    if (driver) {
      try {
        if (driver.caps.reload && driver.reload) {
          await driver.reload();
        } else {
          const sessionFile = await this.currentSessionFile(driver);
          if (sessionFile) {
            const res = await driver.request({ type: "switch_session", sessionPath: sessionFile } as never);
            if (!res.success) throw new DriverError("ROLE_RELOAD_FAILED", String((res as { error?: string }).error ?? "switch_session 失败"));
          }
        }
        if (driver.caps.getSystemPrompt && driver.getSystemPrompt) {
          const prompt = await driver.getSystemPrompt();
          if (prompt) {
            promptHash = createHash("sha256").update(prompt, "utf8").digest("hex").slice(0, 16);
            // ROLE-7：信任校验 — 项目未信任时提示词不会包含所选内容
            if (source) {
              const head = this.preview(cwd, source, 400);
              const headNorm = head.trim().slice(0, 80);
              if (headNorm.length > 0 && !prompt.includes(headNorm.slice(0, 40))) {
                warning = "项目 SYSTEM.md 似乎未生效：项目可能未获信任，请在本机执行 /trust";
              }
            }
          }
        }
      } catch (e) {
        rollback();
        throw new DriverError(
          "ROLE_RELOAD_FAILED",
          `reload 失败已回滚：${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    return {
      source,
      promptHash,
      fallback: source === null ? this.defaultFallbackInfo() : undefined,
      warning,
    };
  }

  private async currentSessionFile(driver: PiDriver): Promise<string | null> {
    try {
      const res = await driver.request({ type: "get_state" } as never);
      if (res.success) return ((res as { data?: { sessionFile?: string } }).data?.sessionFile) ?? null;
    } catch {
      /* ignore */
    }
    return null;
  }
}

function readlinkSyncSafe(p: string): string {
  try {
    return readFilelink(p);
  } catch {
    return "";
  }
}
import { readlinkSync } from "node:fs";
function readFilelink(p: string): string {
  return readlinkSync(p);
}
import { mkdirSync } from "node:fs";
function mkdirpSync(p: string): void {
  mkdirSync(p, { recursive: true });
}
