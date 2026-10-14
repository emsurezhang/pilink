import { useEffect } from "react";
import { useApp } from "./lib/store";
import { hasCredentials } from "./lib/client";
import { PairingGate } from "./components/PairingGate";
import { ConnectionBar } from "./components/ConnectionBar";
import { ChatView } from "./components/ChatView";
import { Sidebar } from "./components/Sidebar";
import { SettingsView } from "./components/SettingsView";
import { UiRequestHost } from "./components/UiRequestDialog";
import { SheetRoot } from "./components/Sheets";

export function App() {
  const s = useApp();
  const authed = hasCredentials();

  useEffect(() => {
    if (authed) {
      s.connect();
      void s.refreshWorkspaces().then(() => s.restoreMostRecent());
      void s.refreshDevices();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed]);

  // L4 会话校准：WS 重连成功 / 页面回前台 / 窗口聚焦时检查历史是否落后
  useEffect(() => {
    if (s.conn === "online") void s.syncIfStale();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.conn]);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void useApp.getState().syncIfStale();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  if (!authed) return <PairingGate />;

  return (
    <div className="flex h-full overflow-hidden bg-bg text-fg">
      {s.tab === "settings" ? (
        <SettingsView />
      ) : (
        <>
          <Sidebar />
          <div className="flex min-w-0 flex-1 flex-col">
            <ConnectionBar />
            <ChatView />
          </div>
        </>
      )}
      <UiRequestHost />
      <SheetRoot />
    </div>
  );
}
