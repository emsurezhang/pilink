/**
 * 文件浏览（workspace 内）：目录列举 + 文本读取（供前端浏览与渲染 Markdown）
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";

export interface FsEntry {
  name: string;
  /** 工作区相对路径（POSIX 分隔） */
  path: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

const MAX_READ_BYTES = 512 * 1024;

/** resolve 后必须仍在 workspace 内，否则返回 null（防路径越界） */
function safeJoin(cwd: string, p: string): string | null {
  const abs = resolve(cwd, p || ".");
  return abs.startsWith(resolve(cwd)) ? abs : null;
}

/** 目录内容：隐藏文件跳过，目录优先按名排序 */
export function listDir(cwd: string, dir: string): FsEntry[] {
  const abs = safeJoin(cwd, dir);
  if (!abs || !existsSync(abs)) return [];
  const out: FsEntry[] = [];
  for (const name of readdirSync(abs)) {
    if (name.startsWith(".")) continue;
    try {
      const st = statSync(join(abs, name));
      out.push({
        name,
        path: relative(cwd, join(abs, name)),
        isDir: st.isDirectory(),
        size: st.size,
        mtime: st.mtimeMs,
      });
    } catch {
      /* 不可读条目跳过 */
    }
  }
  out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  return out;
}

/** 读取文本文件（UTF-8，超限截断） */
export function readText(cwd: string, p: string): { content: string; truncated: boolean; size: number } {
  const abs = safeJoin(cwd, p);
  if (!abs || !existsSync(abs)) throw new Error(`文件不存在：${p}`);
  const st = statSync(abs);
  if (st.isDirectory()) throw new Error("目标是目录");
  const buf = readFileSync(abs);
  const truncated = buf.length > MAX_READ_BYTES;
  return { content: buf.subarray(0, MAX_READ_BYTES).toString("utf8"), truncated, size: st.size };
}
