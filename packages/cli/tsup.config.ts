import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  clean: true,
  // 源码首行已有 shebang，esbuild 会保留
  // 打包 workspace 内的 gateway + protocol
  noExternal: [/^@pilink\//],
});
