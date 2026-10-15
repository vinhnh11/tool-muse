import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const webDir = path.dirname(fileURLToPath(import.meta.url));
/** Backend dev (Express). Ghi đè bằng biến môi trường BVS_API_URL nếu chạy ở cổng khác. */
const apiTarget = process.env.BVS_API_URL || "http://127.0.0.1:7878";

export default defineConfig({
  root: webDir,
  plugins: [react()],
  build: {
    outDir: path.join(webDir, "dist"),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: false,
        // SSE (/api/events): giữ kết nối mở, không nén/đệm
        timeout: 0,
        proxyTimeout: 0,
        configure: (proxy) => {
          proxy.on("proxyRes", (res) => {
            if (String(res.headers["content-type"] ?? "").includes("text/event-stream")) {
              res.headers["cache-control"] = "no-cache, no-transform";
              res.headers["x-accel-buffering"] = "no";
            }
          });
        },
      },
    },
  },
  preview: { host: "127.0.0.1", port: 4173 },
});
