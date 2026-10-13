import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  clean: true,
  // ws 必须打进产物：Host 会把单个 index.js 拷到 ~/.pilink/bridge/ 加载，那里没有 node_modules
  noExternal: [/^@pilink\//, "ws"],
});
