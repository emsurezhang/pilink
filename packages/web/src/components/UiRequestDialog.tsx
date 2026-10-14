import { useEffect, useState } from "react";
import { Info, TriangleAlert, CircleX, Loader2 } from "lucide-react";
import { useApp } from "../lib/store";
import { client } from "../lib/client";

/**
 * 扩展 UI 请求（CMD-10 / rpc-extension-ui，仿 TUI 弹层）。
 *
 * pi 协议分两类：
 *  - dialog（select/confirm/input/editor）：阻塞弹窗，必须回 extension_ui_response，
 *    可带 timeout（agent 侧超时自动兜底，本地到点自动关闭）
 *  - fire-and-forget（notify/setStatus/setWidget/setTitle/set_editor_text）：
 *    不期望响应，notify 用 toast 展示，其余静默
 *  - 未知 method：展示原始 payload
 */
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const QUIET_METHODS = new Set(["setStatus", "setWidget", "setTitle", "set_editor_text"]);

interface Toast {
  id: string;
  text: string;
  kind: string;
}

const TOAST_ICON: Record<string, React.ReactNode> = {
  info: <Info size={14} className="shrink-0 text-accent" />,
  warning: <TriangleAlert size={14} className="shrink-0 text-warn" />,
  error: <CircleX size={14} className="shrink-0 text-danger" />,
};

export function UiRequestHost() {
  const s = useApp();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const items = s.uiRequests;
  const dialogs = items.filter((r) => DIALOG_METHODS.has(r.payload?.method));
  const req = dialogs[0];

  const dismiss = (requestId: string) =>
    s.set({ uiRequests: useApp.getState().uiRequests.filter((x) => x.requestId !== requestId) });

  // fire-and-forget：notify → toast；其余静默吞掉
  useEffect(() => {
    for (const r of items) {
      const m = r.payload?.method as string;
      if (m === "notify") {
        const text = (r.payload?.message as string) ?? (r.payload?.title as string) ?? "扩展通知";
        const kind = (r.payload?.notifyType as string) ?? "info";
        dismiss(r.requestId);
        setToasts((t) => [...t.slice(-2), { id: r.requestId, text, kind }]);
        setTimeout(() => setToasts((t) => t.filter((x) => x.id !== r.requestId)), 4000);
      } else if (QUIET_METHODS.has(m)) {
        dismiss(r.requestId);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  return (
    <>
      {req && (
        <Dialog
          key={req.requestId}
          requestId={req.requestId}
          sessionKey={req.sessionKey}
          payload={req.payload}
          onClose={() => dismiss(req.requestId)}
        />
      )}
      <div className="toast-wrap">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            {TOAST_ICON[t.kind] ?? TOAST_ICON.info}
            <span className="min-w-0 flex-1">{t.text}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function Dialog({
  requestId,
  sessionKey,
  payload,
  onClose,
}: {
  requestId: string;
  sessionKey: Parameters<typeof client.uiResponse>[0];
  payload: any;
  onClose: () => void;
}) {
  const method = payload?.method as string;
  const timeoutMs = typeof payload?.timeout === "number" ? payload.timeout : null;
  const [remain, setRemain] = useState<number | null>(timeoutMs ? Math.ceil(timeoutMs / 1000) : null);
  const [text, setText] = useState<string>((payload?.prefill as string) ?? "");

  const respond = (response: Record<string, unknown>) => {
    client.uiResponse(sessionKey, requestId, response);
    onClose();
  };

  // 超时：agent 侧已自动兜底，本地到点关闭即可
  useEffect(() => {
    if (remain == null) return;
    if (remain <= 0) {
      onClose();
      return;
    }
    const t = setTimeout(() => setRemain(remain - 1), 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remain]);

  return (
    <div className="sheet-backdrop" onClick={() => respond({ cancelled: true })}>
      <div className="sheet-panel" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <span className="rounded-full border border-accent/40 px-2.5 py-0.5 text-[11px] text-accent">
            扩展请求 · {method}
          </span>
          {remain != null && (
            <span className="flex items-center gap-1 text-xs text-warn">
              <Loader2 size={11} className="animate-spin" />
              {remain}s 后自动取消
            </span>
          )}
        </div>
        <h3 className="m-0 text-[15px] font-semibold">{payload?.title ?? "扩展请求"}</h3>
        {payload?.message && <p className="m-0 text-sm whitespace-pre-wrap text-dim">{payload.message}</p>}

        {method === "confirm" && (
          <div className="flex justify-end gap-2">
            <button className="btn" onClick={() => respond({ cancelled: true })}>
              取消
            </button>
            <button className="btn btn-primary" onClick={() => respond({ confirmed: true })}>
              确认
            </button>
          </div>
        )}

        {method === "select" && (
          <div className="flex flex-col gap-1">
            {(payload?.options as string[])?.length ? (
              (payload?.options as string[]).map((opt) => (
                <button key={opt} className="row-item justify-between" onClick={() => respond({ value: opt })}>
                  <span>{opt}</span>
                </button>
              ))
            ) : (
              <p className="text-sm text-warn">扩展未提供选项</p>
            )}
            <button className="row-item text-dim" onClick={() => respond({ cancelled: true })}>
              取消
            </button>
          </div>
        )}

        {method === "input" && (
          <>
            <input
              className="input"
              placeholder={payload?.placeholder}
              value={text}
              onChange={(e) => setText(e.target.value)}
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && respond({ value: text })}
            />
            <div className="flex justify-end gap-2">
              <button className="btn" onClick={() => respond({ cancelled: true })}>
                取消
              </button>
              <button className="btn btn-primary" onClick={() => respond({ value: text })}>
                确定
              </button>
            </div>
          </>
        )}

        {method === "editor" && (
          <>
            <textarea
              className="input min-h-32 resize-y font-[inherit]"
              rows={6}
              value={text}
              placeholder={payload?.placeholder}
              onChange={(e) => setText(e.target.value)}
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button className="btn" onClick={() => respond({ cancelled: true })}>
                取消
              </button>
              <button className="btn btn-primary" onClick={() => respond({ value: text })}>
                确定
              </button>
            </div>
          </>
        )}

        {!DIALOG_METHODS.has(method) && (
          <>
            <pre className="m-0 overflow-x-auto rounded-lg border border-line bg-s1 p-3 text-xs whitespace-pre-wrap break-all">
              {JSON.stringify(payload, null, 2)}
            </pre>
            <div className="flex justify-end">
              <button className="btn" onClick={() => respond({ cancelled: true })}>
                关闭
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
