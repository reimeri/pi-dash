import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4317",
        changeOrigin: true,
        ws: true,
      },
      "/auth": { target: "http://127.0.0.1:4317", changeOrigin: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
