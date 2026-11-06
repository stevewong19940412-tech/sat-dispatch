import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.CLIENT_PORT || "5173", 10);
const API_PORT = process.env.API_PORT || "8600";

export default defineConfig({
  root: resolve(__dirname, "client"),
  plugins: [react()],
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
    outDir: resolve(__dirname, "client/dist"),
    chunkSizeWarningLimit: 1500,
  },
});
