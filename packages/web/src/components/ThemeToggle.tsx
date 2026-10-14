import { useState } from "react";
import { Moon, Sun } from "lucide-react";
import { isDark, toggleTheme } from "../lib/theme";

/** 主题切换（亮色默认 / 暗色），localStorage 持久化 */
export function ThemeToggle() {
  const [dark, setDark] = useState(isDark());
  return (
    <button
      className="icon-btn"
      title={dark ? "切换为亮色" : "切换为暗色"}
      onClick={() => setDark(toggleTheme())}
    >
      {dark ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}
