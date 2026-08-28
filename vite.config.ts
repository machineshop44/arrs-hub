import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const port = Number(
  process.env.ARRS_HUB_PORT || process.env.PORT || 3000,
);

export default defineConfig(({ mode }) => {
  const variant =
    mode === "lite" || process.env.ARRS_HUB_VARIANT === "lite"
      ? "lite"
      : "full";

  return {
    plugins: [react()],
    define: {
      __ARRS_HUB_VARIANT__: JSON.stringify(variant),
    },
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
  };
});
