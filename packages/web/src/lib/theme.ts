/** 主题管理：亮色默认（Manus 基准），暗色可选，localStorage 持久化 */
const KEY = "pilink.theme";

export function initTheme(): void {
  const t = localStorage.getItem(KEY);
  const dark = t ? t === "dark" : false; // 默认亮色
  document.documentElement.classList.toggle("dark", dark);
}

export function isDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

export function toggleTheme(): boolean {
  const dark = !isDark();
  document.documentElement.classList.toggle("dark", dark);
  localStorage.setItem(KEY, dark ? "dark" : "light");
  return dark;
}
