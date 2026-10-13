/**
 * 会话列表（SYNC-5）：解析 Pi 的 JSONL 会话目录，等价本机 /resume。
 */
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { piSessionsRoot, piDirNameForCwd } from "./registry.js";

export interface SessionSummary {
  sessionId: string;
  path: string;
  cwd: string;
  name?: string;
  preview?: string; // 首条用户消息摘要
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  leafId?: string | null;
}

interface ParsedEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  name?: string;
  message?: { role?: string; content?: unknown };
  summary?: string;
}

/** 读取会话文件元信息（限制读取体积，超大文件只读尾部） */
export function summarizeSessionFile(path: string): SessionSummary | null {
  try {
    const stat = statSync(path);
    const MAX_BYTES = 4 * 1024 * 1024;
    let text: string;
    if (stat.size > MAX_BYTES) {
      const fd = readFileSync(path); // 简化：小步读取
      text = fd.subarray(0, MAX_BYTES).toString("utf8");
    } else {
      text = readFileSync(path, "utf8");
    }
    const lines = text.split("\n").filter(Boolean);
    if (lines.length === 0) return null;
    const header = JSON.parse(lines[0]) as { type?: string; cwd?: string; id?: string; timestamp?: string };
    if (header.type !== "session") return null;

    let name: string | undefined;
    let preview: string | undefined;
    let messageCount = 0;
    let leafId: string | null = null;
    const children = new Set<string>();
    const ids = new Set<string>();

    for (let i = 1; i < lines.length; i++) {
      let e: ParsedEntry;
      try {
        e = JSON.parse(lines[i]) as ParsedEntry;
      } catch {
        continue;
      }
      if (!e.id) continue;
      ids.add(e.id);
      if (e.parentId) children.add(e.parentId);
      leafId = e.id; // 追加序最后一条近似叶子（精确值以 get_entries 为准）
      if (e.type === "session_info" && e.name) name = e.name;
      if (e.type === "message" && e.message) {
        messageCount++;
        if (!preview && e.message.role === "user") {
          preview = extractText(e.message.content).slice(0, 120);
        }
      }
      if (e.type === "compaction" && !preview && e.summary) preview = `[压缩] ${e.summary.slice(0, 100)}`;
    }
    // 真正叶子 = 不是任何条目父节点的条目中，按文件序最后者
    for (let i = lines.length - 1; i >= 1; i--) {
      try {
        const e = JSON.parse(lines[i]) as ParsedEntry;
        if (e.id && !children.has(e.id)) {
          leafId = e.id;
          break;
        }
      } catch {
        /* skip */
      }
    }
    const sessionId = path.split("/").pop()!.replace(/\.jsonl$/, "");
    return {
      sessionId,
      path,
      cwd: header.cwd ?? "",
      name,
      preview,
      messageCount,
      createdAt: Date.parse(header.timestamp ?? "") || stat.birthtimeMs,
      updatedAt: stat.mtimeMs,
      leafId,
    };
  } catch {
    return null;
  }
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "object" && b && "text" in b ? String((b as { text?: string }).text ?? "") : ""))
      .join(" ");
  }
  return "";
}

export function listSessionsForCwd(cwd: string, query?: string): SessionSummary[] {
  const dir = join(piSessionsRoot(), `--${piDirNameForCwd(cwd)}--`);
  if (!existsSync(dir)) return [];
  const out: SessionSummary[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const s = summarizeSessionFile(join(dir, f));
    if (s) out.push(s);
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  if (query) {
    const q = query.toLowerCase();
    return out.filter(
      (s) =>
        (s.name ?? "").toLowerCase().includes(q) ||
        (s.preview ?? "").toLowerCase().includes(q) ||
        s.sessionId.toLowerCase().includes(q),
    );
  }
  return out;
}

export function findSessionPath(workspaceId_cwd: string, sessionId: string): string | null {
  const dir = join(piSessionsRoot(), `--${piDirNameForCwd(workspaceId_cwd)}--`);
  const p = join(dir, `${sessionId}.jsonl`);
  return existsSync(p) ? p : null;
}
