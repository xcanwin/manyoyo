import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { viteSingleFile } from "vite-plugin-singlefile"

// 开发模式下把 /api、/auth（含终端 WebSocket，走 /api/sessions/*/terminal/ws）
// 代理到真实运行的 `my serve` 后端，这样热更新的同时操作的是真实容器/会话。
const backendTarget = process.env.MANYOYO_SERVE_URL || "http://127.0.0.1:3000"

// https://vite.dev/config/
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/api": { target: backendTarget, changeOrigin: true, ws: true },
      "/auth": { target: backendTarget, changeOrigin: true },
    },
  },
  build: {
    cssCodeSplit: false,
  },
})
