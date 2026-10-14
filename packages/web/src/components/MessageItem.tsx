import { useMemo, useState } from "react";
import { marked } from "marked";
import {
  Check,
  ChevronRight,
  Copy,
  Loader2,
  Lock,
  X,
} from "lucide-react";
import type { UiMessage, UiToolCall } from "../lib/model";
import { useApp } from "../lib/store";
import { useLongPress } from "../lib/longpress";
import { SheetHost } from "./Sheets";

marked.setOptions({ breaks: true, gfm: true });

/**
 * 消息渲染（Manus 风格）：
 * - 助手消息无气泡：全宽排版，思考/工具/正文为层次块
 * - 用户消息：灰阶 pill 右对齐
 * - 注意：不能用 React.memo —— 流式事件原地累加 UiMessage
 */
export function MessageItem({ message }: { message: UiMessage }) {
  const thinkingMode = useApp((s) => s.thinkingMode);
  if (message.role === "user") return <UserMessage message={message} />;
  if (message.role !== "assistant") return null;

  const hasThinking = message.thinking.length > 0;
  const thinkingText = message.thinking.map((t) => t.text).join("\n");

  return (
    <div className="border-t border-line/60 py-5 first:border-t-0">
      {hasThinking && thinkingMode !== "hidden" && (
        <details className="thinking" open={thinkingMode === "expanded"}>
          <summary>
            <ChevronRight size={13} className="chev" />
            {message.thinking.some((t) => t.encrypted) ? <Lock size={12} /> : null}
            思考过程
            {message.pending && <Dots />}
            {thinkingText && (
              <span className="truncate text-xs text-dim">
                {thinkingText.split("\n").pop()?.slice(0, 48)}
              </span>
            )}
          </summary>
          {message.thinking.some((t) => t.encrypted) ? (
            <p className="px-3 pb-2 text-xs text-dim">思考内容不可见（provider 未返回可读内容）</p>
          ) : (
            <pre>{thinkingText}</pre>
          )}
        </details>
      )}
      {message.toolCalls.map((tc, i) => (
        <ToolCard key={tc.toolCallId ?? i} tc={tc} />
      ))}
      {message.images.map((img, i) => (
        <img key={i} className="mt-2 max-h-72 rounded-xl border border-line" src={`data:${img.mimeType};base64,${img.data}`} alt="" />
      ))}
      {message.text && <Markdown text={message.text} />}
      {message.pending && !message.text && message.toolCalls.length === 0 && <Dots />}
    </div>
  );
}

function Dots() {
  return (
    <span className="dots">
      <span /> <span /> <span />
    </span>
  );
}

function UserMessage({ message }: { message: UiMessage }) {
  const [menu, setMenu] = useState(false);
  const lp = useLongPress(() => setMenu(true));
  return (
    <div className="flex justify-end py-1" {...lp}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu(true);
      }}
    >
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-s2 px-4 py-2.5 whitespace-pre-wrap text-[15px]">
        {message.images.map((img, i) => (
          <img key={i} className="mb-2 max-h-72 rounded-lg" src={`data:${img.mimeType};base64,${img.data}`} alt="" />
        ))}
        {message.text}
      </div>
      {menu && (
        <div className="send-menu" onClick={() => setMenu(false)}>
          <button
            onClick={() => {
              void navigator.clipboard.writeText(message.text);
              setMenu(false);
            }}
          >
            复制
          </button>
          <button
            onClick={() => {
              SheetHost.open("fork", message.key);
              setMenu(false);
            }}
          >
            从此处分叉
          </button>
          <button onClick={() => setMenu(false)}>取消</button>
        </div>
      )}
    </div>
  );
}

function ToolCard({ tc }: { tc: UiToolCall }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-2 rounded-lg border border-line bg-s1">
      <button className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px]" onClick={() => setOpen(!open)}>
        {tc.status === "running" ? (
          <Loader2 size={13} className="animate-spin text-accent" />
        ) : tc.status === "error" ? (
          <X size={13} className="text-danger" />
        ) : (
          <Check size={13} className="text-ok" />
        )}
        <span className="font-medium">{tc.name}</span>
        <span className="flex-1 truncate text-dim">{toolSummary(tc)}</span>
        {tc.durationMs != null && <span className="text-xs text-dim">{(tc.durationMs / 1000).toFixed(1)}s</span>}
        <ChevronRight size={13} className={`text-dim transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="tool-body border-t border-line px-3 py-2">
          {tc.argsText && (
            <>
              <div className="dim-label">参数</div>
              <pre className="code">{tc.argsText.slice(0, 4000)}</pre>
            </>
          )}
          {tc.resultText && (
            <>
              <div className="dim-label">
                输出{tc.resultText.length > 4000 ? `（截断，共 ${tc.resultText.length} 字符）` : ""}
              </div>
              <pre className="code">{tc.resultText.slice(-4000)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function toolSummary(tc: UiToolCall): string {
  const a = tc.args as Record<string, unknown> | undefined;
  if (!a) return tc.argsText.slice(0, 60);
  const file = (v: unknown) => (typeof v === "string" ? v.split("/").pop() : "");
  switch (tc.name) {
    case "read":
    case "edit":
    case "write":
      return file(a.path ?? a.file_path) || tc.name;
    case "bash":
      return String(a.command ?? "").slice(0, 60);
    case "grep":
    case "find":
      return String(a.pattern ?? a.query ?? "").slice(0, 60);
    case "ls":
      return file(a.path ?? ".") || "目录";
    default:
      return JSON.stringify(a).slice(0, 60);
  }
}

/** Markdown 渲染：末条每帧重渲染（务实降级）；代码块带语言标签 + 复制按钮 */
export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text) as string;
    // 代码块注入语言标签与复制按钮
    return raw.replace(
      /<pre><code class="language-([\w-]+)">/g,
      '<pre><span class="code-lang">$1</span><button type="button" class="code-copy">复制</button><code>',
    );
  }, [text]);

  return (
    <div
      className="markdown"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const btn = (e.target as HTMLElement).closest?.(".code-copy");
        if (!btn) return;
        const pre = btn.closest("pre");
        const code = pre?.querySelector("code")?.textContent ?? "";
        void navigator.clipboard.writeText(code);
        btn.textContent = "已复制";
        setTimeout(() => (btn.textContent = "复制"), 1500);
      }}
    />
  );
}
