import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  clean: true,
  sourcemap: true,
  dts: true,
  target: "node22",
  // 打包 workspace 内的 protocol，避免运行时解析 TS 源码入口
  noExternal: [/^@pilink\//],
});
