import { useEffect, useRef, useState } from "react";
import { useApp } from "../lib/store";
import { client } from "../lib/client";
import { useLongPress } from "../lib/longpress";
import { SheetHost } from "./Sheets";
import { CommandPalette, type PaletteHandle } from "./CommandPalette";

/**
 * 输入区（§9.2 / MOB-2/3）：
 * - 回车默认换行，显式发送键；外接键盘 Enter 发送
 * - `/` 命令面板 · `@` 文件引用 · `!` bash（`!!` 不进上下文）
 * - 运行中发送：长按发送键 → Steer / Follow-up（CMD-7）
 * - 草稿按会话保存
 */
export function Composer() {
  const s = useApp();
  const [text, setText] = useState("");
  const [images, setImages] = useState<{ data: string; mimeType: string }[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** 面板搜索词（不含前导 /），随输入框内容同步 */
  const [paletteQuery, setPaletteQuery] = useState("");
  const paletteRef = useRef<PaletteHandle>(null);
  const [filePanel, setFilePanel] = useState<string | null>(null);
  const [sendMenu, setSendMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingQueue, setPendingQueue] = useState<Array<{ id: string; text: string; kind: "steer" | "follow-up" }>>([]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
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
    // 命令面板打开时：↑↓ 选择 / Enter·Tab 补全 / Esc 关闭（消费事件，不再触发发送）
    if (paletteOpen && paletteRef.current?.handleKeyDown(e)) return;
    // 外接键盘：Enter 发送 / Shift+Enter 换行（触屏软键盘回车默认换行）
    if (e.key === "Enter" && !e.shiftKey && e.nativeEvent instanceof KeyboardEvent && !("ontouchstart" in window && e.nativeEvent.keyCode === 0)) {
      // 简单启发：桌面环境 Enter 发送
      if (matchMedia("(pointer: fine)").matches) {
        e.preventDefault();
        void send();
      }
    }
    if (e.key === "Escape" && s.isStreaming) void s.abort();
  }

  function onChange(v: string) {
    setText(v);
    // 以 / 开头且尚未带参数（空格/换行）→ 打开面板并继承已输入内容
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

  return (
    <div className="composer">
      {(s.queue.steering.length > 0 || s.queue.followUp.length > 0 || pendingQueue.length > 0) && (
        <div className="queue-chips">
          {[
            ...s.queue.steering.map((t) => ({ t, k: "steer" })),
            ...s.queue.followUp.map((t) => ({ t, k: "follow-up" })),
            ...pendingQueue.map((item) => ({ t: item.text, k: item.kind })),
          ].map((q, i) => (
            <span key={`${q.k}-${q.t}-${i}`} className={`chip ${q.k}`}>
              {q.k === "steer" ? "↯" : "⏳"} {q.t.slice(0, 24)}
            </span>
          ))}
          <button className="mini" onClick={() => void s.clearQueue()}>
            清空队列
          </button>
        </div>
      )}
      {images.length > 0 && (
        <div className="attach-row">
          {images.map((img, i) => (
            <img key={i} src={`data:${img.mimeType};base64,${img.data}`} onClick={() => setImages(images.filter((_, j) => j !== i))} alt="附件（点击移除）" />
          ))}
        </div>
      )}
      {filePanel !== null && <FilePanel query={filePanel} onPick={insertFile} onClose={() => setFilePanel(null)} />}
      <div className="quick-bar">
        <button title="切换模型 (/model)" onClick={() => SheetHost.open("model")}>𝑀</button>
        <button title="思考等级与显示方式 (/thinking)" onClick={() => SheetHost.open("thinking")}>💭</button>
        <button title="压缩上下文 (/compact)" onClick={() => SheetHost.open("compact")}>🗜</button>
        <button title="新建会话 (/new)" onClick={() => void SheetHost.runCommandText("/new")}>✚</button>
        <button title="会话树 (/tree)" onClick={() => SheetHost.open("tree")}>⑂</button>
        <button title="图片附件（相机/相册）" onClick={() => fileRef.current?.click()}>📎</button>
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => void attachFiles(e.target.files)} />
        <span className="spacer" />
        {s.isStreaming && (
          <button className="abort" title="中止（先清队列，可恢复排队文本）" onClick={() => void handleAbort()}>
            ■ 中止
          </button>
        )}
      </div>
      <div className="input-row">
        <button
          className="slash"
          title="命令面板：/ 命令 · @ 文件引用 · ! bash"
          onClick={() => {
            setText("/");
            setPaletteQuery("");
            setPaletteOpen(true);
            taRef.current?.focus();
          }}
        >
          /
        </button>
        <textarea
          ref={taRef}
          rows={Math.min(6, Math.max(1, text.split("\n").length))}
          placeholder={s.isStreaming ? "运行中：点发送 = Steer，长按发送 = 排队选项" : "输入消息，/ 命令 · @ 文件 · ! bash"}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          enterKeyHint="enter"
        />
        {sendMenu ? (
          <div className="send-menu">
            <button onClick={() => void send("steer")}>↯ Steer（插队）</button>
            <button onClick={() => void send("followUp")}>⏳ Follow-up（排队）</button>
          </div>
        ) : (
          <button
            className="send"
            disabled={busy || !text.trim() || !s.sessionKey}
            onClick={() => void send()}
            {...sendLp}
            title={
              s.isStreaming && !isBash && !isCommand
                ? "Steer（插队）；长按可选 Follow-up 排队"
                : "发送（长按：Steer / Follow-up）"
            }
          >
            {busy ? "…" : s.isStreaming && !isBash && !isCommand ? "↯" : "➤"}
          </button>
        )}
      </div>
      {error && <div className="error small">{error}</div>}
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
