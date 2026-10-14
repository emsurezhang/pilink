import { useEffect, useRef, useState } from "react";
import { Paperclip, Square, Zap, ArrowUp, Slash, Timer } from "lucide-react";
import { useApp } from "../lib/store";
import { client } from "../lib/client";
import { useLongPress } from "../lib/longpress";
import { SheetHost } from "./Sheets";
import { CommandPalette, type PaletteHandle } from "./CommandPalette";

/**
 * 输入区（Manus 风格单行 pill）：
 * - 左侧 / 命令入口，右侧附件 + 发送；发送键运行中变为 Steer
 * - 回车默认换行，显式发送键；外接键盘 Enter 发送
 * - 运行中发送：长按发送键 → Steer / Follow-up（CMD-7）
 * - 草稿按会话保存
 */
export function Composer() {
  const s = useApp();
  const [text, setText] = useState("");
  const [images, setImages] = useState<{ data: string; mimeType: string }[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const paletteRef = useRef<PaletteHandle>(null);
  const [filePanel, setFilePanel] = useState<string | null>(null);
  const [sendMenu, setSendMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingQueue, setPendingQueue] = useState<Array<{ id: string; text: string; kind: "steer" | "follow-up" }>>([]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const draftKey = `pilink.draft.${s.sessionKey ?? "none"}`;

  // 草稿自动保存
  useEffect(() => {
    const saved = localStorage.getItem(draftKey);
    if (saved) setText(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);
  useEffect(() => {
    localStorage.setItem(draftKey, text);
  }, [text, draftKey]);

  // typing 上报（presence）
  useEffect(() => {
    if (!s.sessionKey) return;
    const t = setTimeout(() => client.setTyping(s.sessionKey!, text.length > 0), 300);
    return () => clearTimeout(t);
  }, [text, s.sessionKey]);

  const isBash = text.startsWith("!");
  const isCommand = text.startsWith("/");

  async function send(behavior?: "steer" | "followUp") {
    const value = text.trim();
    if (!value || busy || !s.sessionKey) return;
    const pending: { id: string; text: string; kind: "steer" | "follow-up" } = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      text: value,
      kind: behavior === "steer" ? "steer" : "follow-up",
    };
    setBusy(true);
    setError(null);
    setPendingQueue((prev) => [...prev, pending]);
    try {
      if (isBash) {
        const cmd = value.replace(/^!+/, "").trim();
        if (!cmd) return;
        await s.runBash(cmd, value.startsWith("!!"));
      } else if (isCommand) {
        await SheetHost.runCommandText(value);
      } else {
        await s.sendPrompt(value, images.length ? images : undefined, behavior);
      }
      setText("");
      setImages([]);
      setSendMenu(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setPendingQueue((prev) => prev.filter((item) => item.id !== pending.id));
      taRef.current?.focus();
    }
  }

  async function handleAbort() {
    const q = await s.clearQueue();
    await s.abort();
    const back = [...(q?.steering ?? []), ...(q?.followUp ?? [])];
    if (back.length) setText(back.join("\n"));
  }

  const sendLp = useLongPress(() => {
    if (s.isStreaming && !isBash && !isCommand) setSendMenu(true);
  });

  function onKeyDown(e: React.KeyboardEvent) {
    // 命令面板打开时：↑↓ 选择 / Enter·Tab 补全 / Esc 关闭
    if (paletteOpen && paletteRef.current?.handleKeyDown(e)) return;
    if (e.key === "Enter" && !e.shiftKey && matchMedia("(pointer: fine)").matches) {
      e.preventDefault();
      void send();
    }
    if (e.key === "Escape" && s.isStreaming) void s.abort();
  }

  function onChange(v: string) {
    setText(v);
    if (v.startsWith("/") && !/[\s]/.test(v.slice(1))) {
      setPaletteOpen(true);
      setPaletteQuery(v.slice(1));
    } else {
      setPaletteOpen(false);
    }
    if (v.includes(" @") || v === "@") setFilePanel(v.slice(v.lastIndexOf("@") + 1));
    else setFilePanel(null);
  }

  function insertFile(path: string) {
    const at = text.lastIndexOf("@");
    setText(text.slice(0, at) + `@${path} `);
    setFilePanel(null);
  }

  async function attachFiles(files: FileList | null) {
    if (!files) return;
    for (const f of Array.from(files).slice(0, 4)) {
      if (!f.type.startsWith("image/")) continue;
      const data = await new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1]);
        r.readAsDataURL(f);
      });
      setImages((prev) => [...prev, { data, mimeType: f.type }]);
    }
  }

  const queueChips = [
    ...s.queue.steering.map((t) => ({ t, k: "steer" as const })),
    ...s.queue.followUp.map((t) => ({ t, k: "follow-up" as const })),
    ...pendingQueue.map((item) => ({ t: item.text, k: item.kind })),
  ];

  return (
    <div ref={wrapRef} className="relative border-t border-line bg-s1 px-3 pt-2" style={{ paddingBottom: "calc(8px + var(--sab))" }}>
      {queueChips.length > 0 && (
        <div className="mb-1.5 flex gap-1.5 overflow-x-auto pb-0.5 text-xs">
          {queueChips.map((q, i) => (
            <span key={`${q.k}-${q.t}-${i}`} className={`chip shrink-0 ${q.k === "steer" ? "text-warn" : "text-accent"}`}>
              {q.k === "steer" ? <Zap size={11} /> : <Timer size={11} />}
              {q.t.slice(0, 24)}
            </span>
          ))}
          <button className="btn-ghost btn shrink-0 !px-2 !py-0.5 text-xs" onClick={() => void s.clearQueue()}>
            清空
          </button>
        </div>
      )}

      {images.length > 0 && (
        <div className="mb-1.5 flex gap-1.5">
          {images.map((img, i) => (
            <img
              key={i}
              className="h-12 rounded-lg border border-line"
              src={`data:${img.mimeType};base64,${img.data}`}
              onClick={() => setImages(images.filter((_, j) => j !== i))}
              alt="附件（点击移除）"
            />
          ))}
        </div>
      )}

      {filePanel !== null && <FilePanel query={filePanel} onPick={insertFile} onClose={() => setFilePanel(null)} />}

      {/* 输入 pill */}
      <div className="flex items-end gap-1 rounded-2xl border border-line bg-bg px-2 py-1.5 transition-colors focus-within:border-accent">
        <button
          className="icon-btn"
          title="命令面板：/ 命令 · @ 文件引用 · ! bash"
          onClick={() => {
            setText("/");
            setPaletteQuery("");
            setPaletteOpen(true);
            taRef.current?.focus();
          }}
        >
          <Slash size={16} />
        </button>
        <textarea
          ref={taRef}
          rows={Math.min(6, Math.max(1, text.split("\n").length))}
          className="max-h-40 min-h-[32px] flex-1 resize-none bg-transparent text-[15px] outline-none"
          placeholder={s.isStreaming ? "运行中：点发送 = Steer，长按发送 = 排队选项" : "输入消息，/ 命令 · @ 文件 · ! bash"}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          enterKeyHint="enter"
        />
        <button className="icon-btn" title="图片附件（相机/相册）" onClick={() => fileRef.current?.click()}>
          <Paperclip size={16} />
        </button>
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => void attachFiles(e.target.files)} />
        {sendMenu ? (
          <div className="send-menu">
            <button onClick={() => void send("steer")}>
              <Zap size={13} className="mr-1 inline text-warn" />
              Steer（插队）
            </button>
            <button onClick={() => void send("followUp")}>
              <Timer size={13} className="mr-1 inline text-accent" />
              Follow-up（排队）
            </button>
          </div>
        ) : (
          <button
            className={`flex size-8 shrink-0 items-center justify-center rounded-full p-0 text-white transition-all ${
              busy ? "bg-line2" : s.isStreaming && !isBash && !isCommand ? "bg-warn" : "bg-accent hover:brightness-105"
            }`}
            disabled={busy || !text.trim() || !s.sessionKey}
            onClick={() => void send()}
            {...sendLp}
            title={
              s.isStreaming && !isBash && !isCommand
                ? "Steer（插队）；长按可选 Follow-up 排队"
                : "发送（长按：Steer / Follow-up）"
            }
          >
            {busy ? (
              <span className="size-3 animate-spin rounded-full border-2 border-bg/40 border-t-bg" />
            ) : s.isStreaming && !isBash && !isCommand ? (
              <Zap size={15} />
            ) : (
              <ArrowUp size={16} />
            )}
          </button>
        )}
      </div>

      {s.isStreaming && (
        <button
          className="btn-ghost btn mx-auto mt-1 flex !px-2 !py-0.5 text-xs text-danger"
          title="中止（先清队列，可恢复排队文本）"
          onClick={() => void handleAbort()}
        >
          <Square size={11} />
          中止
        </button>
      )}

      {error && <div className="mt-1 text-xs text-danger">{error}</div>}

      <CommandPalette
        ref={paletteRef}
        open={paletteOpen}
        query={paletteQuery}
        onClose={() => setPaletteOpen(false)}
        onFill={(v) => {
          setText(v);
          setPaletteOpen(false);
          taRef.current?.focus();
        }}
      />
    </div>
  );
}

function FilePanel({ query, onPick, onClose }: { query: string; onPick: (p: string) => void; onClose: () => void }) {
  const s = useApp();
  const [files, setFiles] = useState<string[]>([]);
  useEffect(() => {
    if (!s.workspaceId) return;
    const t = setTimeout(() => {
      void client
        .gw<{ files: string[] }>({ op: "fs.search", workspaceId: s.workspaceId!, query, limit: 8 })
        .then((r) => setFiles(r.files))
        .catch(() => setFiles([]));
    }, 200);
    return () => clearTimeout(t);
  }, [query, s.workspaceId]);
  if (!files.length) return null;
  return (
    <div className="file-panel">
      {files.map((f) => (
        <button key={f} onClick={() => onPick(f)}>
          📄 {f}
        </button>
      ))}
      <button onClick={onClose}>关闭</button>
    </div>
  );
}
