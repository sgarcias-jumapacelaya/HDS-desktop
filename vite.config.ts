import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri exposes its own env vars; the dev server must run on a fixed port.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2021",
    sourcemap: true,
  },
});
