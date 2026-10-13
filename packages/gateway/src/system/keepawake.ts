/**
 * 保持唤醒（电源需求）：以 caffeinate 绑定 Gateway 自身 PID。
 * 合盖运行需外接电源/外显等条件，见运维手册。
 */
import { spawn, type ChildProcess } from "node:child_process";

let caffeinate: ChildProcess | null = null;

export function setKeepAwake(enabled: boolean): boolean {
  if (enabled && !caffeinate) {
    // -i: 阻止系统空闲睡眠；-s: 接电源时阻止（此处用 -i 即可，文档说明条件）
    caffeinate = spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
    caffeinate.on("exit", () => {
      caffeinate = null;
    });
    return true;
  }
  if (!enabled && caffeinate) {
    caffeinate.kill("SIGTERM");
    caffeinate = null;
    return false;
  }
  return enabled;
}

export function isKeepAwake(): boolean {
  return caffeinate !== null;
}
