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

  if (!authed) return <PairingGate />;

  return (
    <div className="app">
      {s.tab === "settings" ? (
        <SettingsView />
      ) : (
        <>
          <Sidebar />
          <div className="main">
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
