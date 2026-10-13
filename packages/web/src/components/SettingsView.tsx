import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { client } from "../lib/client";

export function SettingsView() {
  const s = useApp();
  const [vapidKey, setVapidKey] = useState<string | null>(null);
  useEffect(() => {
    void s.refreshDevices();
    void client
      .gw<{ pushPublicKey?: string }>({ op: "devices.list" })
      .then((r) => setVapidKey(r.pushPublicKey ?? null))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function revoke(deviceId: string) {
    if (!confirm("吊销该设备？其令牌将立即失效。")) return;
    await client.gw({ op: "devices.revoke", deviceId });
    await s.refreshDevices();
  }

  return (
    <div className="settings-page">
      <header className="settings-head">
        <button className="icon-btn" onClick={() => s.set({ tab: "chat" })}>
          ← 返回
        </button>
        <strong>设置</strong>
      </header>
      <div className="settings">
        <h3>设备（上限见 Gateway 配置，默认 5）</h3>
      <div className="sheet-list">
        {s.devices.map((d) => (
          <div key={d.deviceId} className="device-row">
            <span>
              {d.online ? "🟢" : "⚪"} {d.name}
              {d.online && <span className="dim small">（在线）</span>}
            </span>
            <span className="dim small">
              配对 {new Date(d.pairedAt).toLocaleDateString()} · 最近在线 {new Date(d.lastSeenAt).toLocaleString()}
            </span>
            {!d.revoked && <button onClick={() => void revoke(d.deviceId)}>吊销</button>}
          </div>
        ))}
      </div>
      <h3>推送</h3>
      <p className="dim small">
        {vapidKey
          ? "Web Push 已启用（iOS 需「添加到主屏」后生效，≥16.4）"
          : "未配置 VAPID 密钥，推送不可用（可在 Gateway 配置 vapid* 字段）"}
      </p>
      <h3>保持唤醒</h3>
      <div className="row">
        <button
          onClick={() =>
            void client
              .gw<{ enabled: boolean }>({ op: "host.keepAwake", enabled: true })
              .then((r) => alert(r.enabled ? "已开启 caffeinate（合盖运行需外接电源等条件）" : "开启失败"))
          }
        >
          开启
        </button>
        <button onClick={() => void client.gw({ op: "host.keepAwake", enabled: false })}>关闭</button>
      </div>
      <h3>关于</h3>
      <p className="dim small">
        Gateway v{s.serverVersion} · Pi {s.piVersion}
      </p>
      <button className="danger" onClick={() => confirm("退出登录并清除本设备凭证？") && s.logout()}>
        退出登录
      </button>
      </div>
    </div>
  );
}
