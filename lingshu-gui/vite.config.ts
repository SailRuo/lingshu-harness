import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { createManualChunks } from "./scripts/manualChunks.js";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// HTTPS dev gateway (docker nginx -> host Vite). Example: lingshu.lan
// @ts-expect-error process is a nodejs global
const devDomain = process.env.LINGSHU_DEV_DOMAIN?.trim() || "";

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    vue(),
    {
      name: "vrm-static",
      configureServer(server) {
        const modelsDir = path.resolve(__dirname, "../../.lingshu/models");
        server.middlewares.use("/lingshu-models", (req, res, next) => {
          if (!req.url) return next();
          const filePath = path.join(modelsDir, req.url);
          if (filePath.startsWith(modelsDir)) {
            res.setHeader("Access-Control-Allow-Origin", "*");
            fs.stat(filePath, (err, stat) => {
              if (err) return next();
              res.setHeader("Content-Type", "application/octet-stream");
              fs.createReadStream(filePath).pipe(res);
            });
          } else {
            next();
          }
        });
      },
    },
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks: createManualChunks(),
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || '0.0.0.0', // 允许局域网访问
    allowedHosts: devDomain ? [devDomain, "localhost"] : true,
    hmr: devDomain
      ? {
          protocol: "wss",
          host: devDomain,
          clientPort: 443,
        }
      : host
        ? {
            protocol: "ws",
            host,
            port: 1421,
          }
        : true,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
