import { useState } from "react";
import { KeyRound, Loader2, ShieldCheck, Smartphone } from "lucide-react";
import { pairAndLogin } from "../lib/client";
import { useApp } from "../lib/store";

/** 设备配对（SEC-1）：输入本机终端显示的一次性配对码。 */
export function PairingGate() {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const conn = useApp((s) => s.conn);

  async function submit() {
    if (code.length !== 8 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const name = `${navigator.platform || "设备"} · ${new Date().toLocaleDateString()}`;
      await pairAndLogin(code, name);
      location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-4 md:p-6">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-s1 p-8 shadow-sm">
        <div className="mb-1 flex items-center gap-2">
          <div className="flex size-9 items-center justify-center rounded-xl bg-accent/10">
            <Smartphone size={18} className="text-accent" />
          </div>
          <h1 className="m-0 text-xl font-bold">PiLink</h1>
        </div>
        <p className="mb-5 text-sm text-dim">手机与本机共享同一个 Pi 会话</p>

        <label className="mb-1.5 block text-xs font-medium text-dim">配对码</label>
        <input
          className="input mb-1 text-center text-lg tracking-[0.35em]"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={8}
          placeholder="00000000"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          autoFocus
        />
        <p className="mb-4 text-xs text-dim">
          在本机终端执行 <code className="rounded bg-s2 px-1 py-0.5 font-mono text-[11px]">pilink pair</code>，输入显示的 8 位配对码
        </p>

        <button className="btn btn-primary w-full" disabled={code.length !== 8 || busy} onClick={() => void submit()}>
          {busy ? (
            <>
              <Loader2 size={15} className="animate-spin" />
              配对中…
            </>
          ) : (
            <>
              <KeyRound size={15} />
              配对并登录
            </>
          )}
        </button>

        {error && <p className="mt-3 text-xs text-danger">{error}</p>}

        <div className="mt-5 flex items-start gap-2 border-t border-line pt-4 text-xs text-dim">
          <ShieldCheck size={13} className="mt-0.5 shrink-0" />
          <span>
            需要 HTTPS 安全上下文（WebCrypto 设备密钥）
            {conn === "offline" && " · 当前无法连接 Gateway"}
          </span>
        </div>
      </div>
    </div>
  );
}
