/**
 * @ 文件引用搜索（CMD-6）：遵守 .gitignore 的常见规则（忽略目录 + 根 .gitignore 前缀匹配）。
 */
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  "vendor",
  ".idea",
  ".vscode",
]);
const MAX_FILES = 20_000;

export function searchFiles(cwd: string, query: string, limit = 20): string[] {
  const gitignore = loadGitignore(cwd);
  const q = query.toLowerCase().replace(/^\//, "");
  const results: string[] = [];
  let scanned = 0;

  const walk = (dir: string, depth: number): void => {
    if (results.length >= limit || scanned >= MAX_FILES || depth > 8) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    scanned += entries.length;
    for (const name of entries) {
      if (results.length >= limit) return;
      if (IGNORE_DIRS.has(name)) continue;
      const full = join(dir, name);
      let rel: string;
      try {
        rel = relative(cwd, full);
        if (gitignore.some((p) => rel === p || rel.startsWith(p + "/"))) continue;
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full, depth + 1);
        } else if (st.isFile()) {
          const rl = rel.toLowerCase();
          if (!q || subsequenceMatch(rl, q)) results.push(rel);
        }
      } catch {
        /* 权限等 */
      }
    }
  };
  walk(cwd, 0);
  // 前缀/子串优先，其次子序列得分（简单排序）
  return results.sort((a, b) => score(a, q) - score(b, q)).slice(0, limit);
}

function score(path: string, q: string): number {
  const p = path.toLowerCase();
  if (p.startsWith(q)) return 0;
  if (p.includes("/" + q) || p.includes(q)) return 1;
  return 2;
}

function subsequenceMatch(text: string, q: string): boolean {
  if (!q) return true;
  let i = 0;
  for (const ch of text) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return false;
}

function loadGitignore(cwd: string): string[] {
  const p = join(cwd, ".gitignore");
  if (!existsSync(p)) return [];
  try {
    return readFileSync(p, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && !l.startsWith("!"))
      .map((l) => l.replace(/\/$/, ""));
  } catch {
    return [];
  }
}
