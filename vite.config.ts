import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const port = Number(
  process.env.ARRS_HUB_PORT || process.env.PORT || 3000,
);

export default defineConfig({
  plugins: [react()],
  server: {
    port,
    strictPort: true,
    open: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3847",
        changeOrigin: true,
      },
    },
  },
});
