import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: [],
      manifest: {
        name: "PiLink",
        short_name: "PiLink",
        description: "手机与本机共享同一个 Pi 会话",
        display: "standalone",
        orientation: "portrait",
        background_color: "#0b0f14",
        theme_color: "#0b0f14",
        icons: [
          { src: "pwa-192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512.png", sizes: "512x512", type: "image/png" },
          { src: "pwa-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // 不缓存会话数据与 API（§9.4）
        navigateFallbackDenylist: [/^\/api/, /^\/ws/],
        runtimeCaching: [],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:7788",
      "/ws": { target: "ws://127.0.0.1:7788", ws: true },
    },
  },
});
