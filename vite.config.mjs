import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.CLIENT_PORT || "5173", 10);
const API_PORT = process.env.API_PORT || "8600";

function removeAgentPreload() {
  return {
    name: "remove-agent-preload",
    closeBundle() {
      const fs = require("fs");
      const path = "client/dist/index.html";
      let html = fs.readFileSync(path, "utf-8");
      html = html.replace(/<link rel="modulepreload"[^>]*href="\/assets\/agent-[^"]*"[^>]*>\n?/g, "");
      fs.writeFileSync(path, html);
    }
  };
}

export default defineConfig({
  root: resolve(__dirname, "client"),
  plugins: [ removeAgentPreload(),react()],
  server: {
    host: "0.0.0.0",
    port: PORT,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        // agent chunk 按需加载：禁用动态 import 的预取提示（首屏不拉 1MB SDK）
        experimental: {}
      }
    },
    outDir: resolve(__dirname, "client/dist"),
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/three") || id.includes("node_modules/.pnpm/three")) return "three";
          if (id.includes("node_modules/@blade-hq")) return "agent";
          if (id.includes("node_modules/react") || id.includes("node_modules/scheduler")) return "reactvendor";
        },
      },
    },
  },
});
