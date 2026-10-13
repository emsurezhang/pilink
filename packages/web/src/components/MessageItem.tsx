import { useMemo, useState } from "react";
import { marked } from "marked";
import type { UiMessage, UiToolCall } from "../lib/model";
import { useApp } from "../lib/store";
import { useLongPress } from "../lib/longpress";
import { SheetHost } from "./Sheets";

marked.setOptions({ breaks: true, gfm: true });

/**
 * 注意：不能用 React.memo —— 流式事件是原地累加 UiMessage，
 * memo 的引用比较会阻止 text_delta 等增量更新渲染（已知 bug #2 的根因）。
 * Markdown 组件内部已用 useMemo(text) 缓存，全量重渲染成本可控。
 */
export function MessageItem({ message }: { message: UiMessage }) {
  const thinkingMode = useApp((s) => s.thinkingMode);
  if (message.role === "user") return <UserMessage message={message} />;
  if (message.role !== "assistant") return null;

  const hasThinking = message.thinking.length > 0;
  const thinkingText = message.thinking.map((t) => t.text).join("\n");

  return (
    <div className="msg assistant">
      {hasThinking && thinkingMode !== "hidden" && (
        <details className="thinking" open={thinkingMode === "expanded"}>
          <summary>
            💭 思考{message.pending && <span className="pulse">…</span>}
            <span className="dim small"> {thinkingText.split("\n").pop()?.slice(0, 60)}</span>
          </summary>
          {message.thinking.some((t) => t.encrypted) ? (
            <p className="dim">思考内容不可见（provider 未返回可读内容）</p>
          ) : (
            <pre>{thinkingText}</pre>
          )}
        </details>
      )}
      {message.toolCalls.map((tc, i) => (
        <ToolCard key={tc.toolCallId ?? i} tc={tc} />
      ))}
      {message.images.map((img, i) => (
        <img key={i} className="msg-image" src={`data:${img.mimeType};base64,${img.data}`} alt="" />
      ))}
      {message.text && <Markdown text={message.text} />}
      {message.pending && !message.text && !message.toolCalls.length && <span className="pulse">●</span>}
    </div>
  );
}

function UserMessage({ message }: { message: UiMessage }) {
  const [menu, setMenu] = useState(false);
  const lp = useLongPress(() => setMenu(true));
  return (
    <div
      className="msg user"
      {...lp}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu(true);
      }}
    >
      {message.images.map((img, i) => (
        <img key={i} className="msg-image" src={`data:${img.mimeType};base64,${img.data}`} alt="" />
      ))}
      <div className="bubble">{message.text}</div>
      {menu && (
        <div className="ctx-menu" onClick={() => setMenu(false)}>
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
  const summary = toolSummary(tc);
  return (
    <div className={`tool-card ${tc.status}`} onClick={() => setOpen(!open)}>
      <div className="tool-head">
        <span className="tool-status">{tc.status === "running" ? "▶" : tc.status === "error" ? "✖" : "✔"}</span>
        <span className="tool-name">{tc.name}</span>
        <span className="tool-summary">{summary}</span>
        {tc.durationMs != null && <span className="dim small">{(tc.durationMs / 1000).toFixed(1)}s</span>}
        <span className="chevron">{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <div className="tool-body">
          {tc.argsText && (
            <>
              <div className="dim small">参数</div>
              <pre className="code">{tc.argsText.slice(0, 4000)}</pre>
            </>
          )}
          {tc.resultText && (
            <>
              <div className="dim small">输出{tc.resultText.length > 4000 ? "（截断，共 " + tc.resultText.length + " 字符）" : ""}</div>
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
  if (!a) return tc.argsText.slice(0, 80);
  const file = (v: unknown) => (typeof v === "string" ? v.split("/").pop() : "");
  switch (tc.name) {
    case "read":
      return file(a.path ?? a.file_path) || tc.name;
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

export function Markdown({ text }: { text: string }) {
  // 流式阶段：每帧重渲染最后一条（增量解析的简化实现，§7.2-2 的务实降级）
  const html = useMemo(() => marked.parse(text) as string, [text]);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
