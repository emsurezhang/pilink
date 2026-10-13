import { useEffect, useState } from "react";
import { useApp, type UiRequestItem } from "../lib/store";
import { client } from "../lib/client";

/**
 * 扩展 UI 请求（CMD-10 / rpc-extension-ui）。
 *
 * pi 协议分两类：
 *  - dialog（select/confirm/input/editor）：阻塞弹窗，必须回 extension_ui_response，
 *    可带 timeout（agent 侧超时自动兜底，本地到点自动关闭）
 *  - fire-and-forget（notify/setStatus/setWidget/setTitle/set_editor_text）：
 *    不期望响应，notify 用轻量 toast 展示，其余静默吞掉，不挡用户操作
 *  - 未知 method：展示原始 payload，避免“弹了窗但不知道要干什么”
 */
const METHOD_LABEL: Record<string, string> = {
  select: "选择",
  confirm: "确认",
  input: "输入",
  editor: "编辑",
  notify: "通知",
  setStatus: "状态",
  setWidget: "组件",
  setTitle: "标题",
  set_editor_text: "编辑框",
};
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const QUIET_METHODS = new Set(["setStatus", "setWidget", "setTitle", "set_editor_text"]);

interface Toast {
  id: string;
  text: string;
  kind: string;
}

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
        setToasts((t) => [...t.slice(-2), { id: r.requestId, text, kind }]); // 最多叠 3 条
        setTimeout(() => setToasts((t) => t.filter((x) => x.id !== r.requestId)), 4000);
      } else if (QUIET_METHODS.has(m)) {
        dismiss(r.requestId);
      }
    }
  }, [items]);

  return (
    <>
      {req && <Dialog key={req.requestId} requestId={req.requestId} sessionKey={req.sessionKey} payload={req.payload} onClose={() => dismiss(req.requestId)} />}
      <div className="toast-wrap">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.text}
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
  sessionKey: UiRequestItem["sessionKey"];
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

  // 超时：agent 侧已自动兜底，本地到点关闭即可，无需再回包
  useEffect(() => {
    if (remain == null) return;
    if (remain <= 0) {
      onClose();
      return;
    }
    const t = setTimeout(() => setRemain(remain - 1), 1000);
    return () => clearTimeout(t);
  }, [remain]);

  return (
    <div className="sheet-backdrop">
      <div className="sheet">
        <div className="ui-head">
          <span className="ui-badge">{METHOD_LABEL[method] ?? "扩展请求"}</span>
          {remain != null && <span className="ui-timeout">{remain}s 后自动取消</span>}
        </div>
        <h3>{payload?.title ?? "扩展请求"}</h3>
        {payload?.message && <p className="ui-msg">{payload.message}</p>}

        {method === "confirm" && (
          <div className="row">
            <button className="primary" onClick={() => respond({ confirmed: true })}>确认</button>
            <button onClick={() => respond({ cancelled: true })}>取消</button>
          </div>
        )}

        {method === "select" && (
          <div className="sheet-list">
            {(payload?.options as string[])?.length ? (
              (payload?.options as string[]).map((opt) => (
                <button key={opt} onClick={() => respond({ value: opt })}>{opt}</button>
              ))
            ) : (
              <p className="notice">扩展未提供选项</p>
            )}
            <button onClick={() => respond({ cancelled: true })}>取消</button>
          </div>
        )}

        {method === "input" && (
          <>
            <input
              placeholder={payload?.placeholder}
              value={text}
              onChange={(e) => setText(e.target.value)}
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && respond({ value: text })}
            />
            <div className="row">
              <button className="primary" onClick={() => respond({ value: text })}>确定</button>
              <button onClick={() => respond({ cancelled: true })}>取消</button>
            </div>
          </>
        )}

        {method === "editor" && (
          <>
            <textarea
              rows={6}
              value={text}
              placeholder={payload?.placeholder}
              onChange={(e) => setText(e.target.value)}
              autoFocus
            />
            <div className="row">
              <button className="primary" onClick={() => respond({ value: text })}>确定</button>
              <button onClick={() => respond({ cancelled: true })}>取消</button>
            </div>
          </>
        )}

        {!DIALOG_METHODS.has(method) && (
          <>
            <pre className="ui-raw">{JSON.stringify(payload, null, 2)}</pre>
            <div className="row">
              <button className="primary" onClick={() => respond({ cancelled: true })}>关闭</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
