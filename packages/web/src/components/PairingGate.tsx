import { useState } from "react";
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
    <div className="pairing">
      <h1>PiLink</h1>
      <p className="dim">在本机终端执行 <code>pilink pair</code>，输入显示的 8 位配对码：</p>
      <input
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={8}
        placeholder="00000000"
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
        onKeyDown={(e) => e.key === "Enter" && void submit()}
        autoFocus
      />
      <button disabled={code.length !== 8 || busy} onClick={() => void submit()}>
        {busy ? "配对中…" : "配对并登录"}
      </button>
      {error && <p className="error">{error}</p>}
      <p className="dim small">需要 HTTPS 安全上下文（WebCrypto 设备密钥）{conn === "offline" && " · 当前无法连接 Gateway"}</p>
    </div>
  );
}
