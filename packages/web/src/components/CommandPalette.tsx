import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useApp } from "../lib/store";
import { NEEDS_ARGS, runBuiltin, runDynamicCommand } from "../lib/commands";
import type { DynamicCommand } from "../lib/commands";
import type { BuiltinCommandInfo } from "@pilink/protocol";

const RECENT_KEY = "pilink.recentCommands";

function loadRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}
function pushRecent(name: string): void {
  const r = [name, ...loadRecent().filter((n) => n !== name)].slice(0, 8);
  localStorage.setItem(RECENT_KEY, JSON.stringify(r));
}

interface Item {
  name: string;
  description?: string;
  source: string;
  argHint?: string;
  availability?: string;
  run: (args: string) => Promise<string | void>;
}

export interface PaletteHandle {
  /** 由输入框转发键盘事件；返回 true 表示已消费（↑↓/Enter/Tab/Esc） */
  handleKeyDown: (e: React.KeyboardEvent) => boolean;
}

/**
 * 命令补全列表（仿 TUI）：无独立搜索框，用户始终在原输入框打字；
 * 列表悬浮在输入框上方（不遮挡输入），无匹配时整体隐藏。
 */
export const CommandPalette = forwardRef<PaletteHandle, { open: boolean; query: string; onFill: (v: string) => void; onClose: () => void }>(
  function CommandPalette({ open, query, onFill, onClose }, ref) {
    const s = useApp();
    const [notice, setNotice] = useState<string | null>(null);
    const [active, setActive] = useState(0);
    const listRef = useRef<HTMLDivElement>(null);

    // 过滤结果变化时重置选中项与提示
    useEffect(() => {
      setActive(0);
      setNotice(null);
    }, [query]);

    // 选中项保持可见
    useEffect(() => {
      listRef.current?.querySelector(".palette-item.active")?.scrollIntoView({ block: "nearest" });
    }, [active]);

    const items = useMemo<Item[]>(() => {
      // 仅保留可远程执行的命令（availability=full；缺省视为 full）
      const builtins: Item[] = (s.commands.builtin as BuiltinCommandInfo[])
        .filter((b) => b.availability === "full")
        .map((b) => ({
          name: b.name,
          description: b.description,
          source: "builtin",
          argHint: b.argHint,
          availability: b.availability,
          run: (args) => runBuiltin(b.name, args),
        }));
      const dynamics: Item[] = (s.commands.dynamic as DynamicCommand[])
        .filter((d) => !d.availability || d.availability === "full")
        .map((d) => ({
          name: d.name,
          description: d.description ?? "",
          source: d.source,
          run: (args) => runDynamicCommand(d.name, args),
        }));
      return [...dynamics, ...builtins]; // 同名时扩展优先（§6.1，以 Pi 实际行为为准）
    }, [s.commands]);

    const filtered = useMemo(() => {
      const q = query.toLowerCase().replace(/^\//, "");
      const scored = items
        .map((it) => {
          const n = it.name.toLowerCase();
          let score = -1;
          if (!q) score = 0;
          else if (n.startsWith(q)) score = 3;
          else if (n.includes(q)) score = 2;
          else if (subsequence(q, n)) score = 1;
          return { it, score };
        })
        .filter((x) => x.score >= 0);
      scored.sort((a, b) => {
        const ra = loadRecent().indexOf(a.it.name);
        const rb = loadRecent().indexOf(b.it.name);
        const fa = ra >= 0 ? 100 - ra : 0;
        const fb = rb >= 0 ? 100 - rb : 0;
        return fb - fa || b.score - a.score || a.it.name.localeCompare(b.it.name);
      });
      return scored.map((x) => x.it);
    }, [items, query]);

    // 分组 + 拍平（键盘导航需要连续的序号）
    const { rows, flat } = useMemo(() => {
      const groups: [string, Item[]][] = [
        ["技能", filtered.filter((i) => i.source === "skill")],
        ["扩展", filtered.filter((i) => i.source === "extension")],
        ["模板", filtered.filter((i) => i.source === "prompt")],
        ["内置", filtered.filter((i) => i.source === "builtin")],
      ];
      const rows: ({ kind: "header"; label: string } | { kind: "item"; item: Item; index: number })[] = [];
      const items: Item[] = [];
      for (const [g, list] of groups) {
        const slice = list.slice(0, 12);
        if (slice.length === 0) continue;
        rows.push({ kind: "header", label: g });
        for (const it of slice) {
          rows.push({ kind: "item", item: it, index: items.length });
          items.push(it);
        }
      }
      return { rows, flat: items };
    }, [filtered]);

    async function pick(item: Item) {
      pushRecent(item.name);
      // 动态命令（扩展 /system-prompt 等、技能、模板）与需参命令：自动补全到输入框，不直接执行
      if (item.source !== "builtin" || NEEDS_ARGS.has(item.name)) {
        onFill(`/${item.name} `);
        return;
      }
      try {
        const result = await item.run("");
        if (typeof result === "string") {
          if (result.startsWith("__PROMPT__:")) onFill(`/${result.slice(11)} `);
          else if (result.startsWith("__SHEET__:")) {
            onClose();
            const { SheetHost } = await import("./Sheets");
            SheetHost.open(result.slice(10) as never);
          } else setNotice(result); // 面板保持打开展示结果，Esc 关闭
        } else {
          onClose(); // 无返回值的命令（如 resume/settings）执行完即关
        }
      } catch (e) {
        setNotice(e instanceof Error ? e.message : String(e));
      }
    }

    useImperativeHandle(
      ref,
      () => ({
        handleKeyDown(e: React.KeyboardEvent) {
          if (e.key === "Escape") {
            onClose();
            return true;
          }
          if (flat.length === 0) return false; // 无匹配：列表已隐藏，Enter 正常发送
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, flat.length - 1));
            return true;
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
            return true;
          }
          if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            const it = flat[active] ?? flat[0];
            if (it) void pick(it);
            return true;
          }
          return false;
        },
      }),
      [flat, active],
    );

    // 无匹配 → 列表消失
    if (!open || flat.length === 0) return null;

    return (
      <div className="absolute inset-x-2 bottom-full z-50 mb-2 flex max-h-[min(320px,42vh)] flex-col gap-0.5 overflow-y-auto rounded-xl border border-line bg-bg p-1.5 shadow-2xl">
        {notice && <div className="rounded-md bg-warn/10 px-2.5 py-1.5 text-xs text-warn">{notice}</div>}
        <div ref={listRef}>
          {rows.map((row) =>
            row.kind === "header" ? (
              <div key={`h-${row.label}`} className="group-title">
                {row.label}
              </div>
            ) : (
              <button
                key={row.item.name}
                className={`row-item gap-2.5 ${row.index === active ? "bg-s2" : ""}`}
                onMouseEnter={() => setActive(row.index)}
                onClick={() => void pick(row.item)}
              >
                <span className="shrink-0 font-mono text-[13px] text-accent">/{row.item.name}</span>
                {row.item.argHint && <span className="shrink-0 text-xs text-dim">{row.item.argHint}</span>}
                <span className="min-w-0 flex-1 truncate text-xs text-dim">{row.item.description}</span>
              </button>
            ),
          )}
        </div>
      </div>
    );
  },
);

function subsequence(q: string, text: string): boolean {
  let i = 0;
  for (const ch of text) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return i === q.length;
}
