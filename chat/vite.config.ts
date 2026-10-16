import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";
export default defineConfig(({ mode, command }) => {
  const env = {
    ...loadEnv(mode, "..", ""),
    ...loadEnv(mode, ".", ""),
    ...process.env,
  };
  const proxy = {
    "/api": {
      target: env.API_PROXY_TARGET || `http://127.0.0.1:${env.PORT || 3020}`,
      changeOrigin: true,
    },
  };
  return {
    base: command === "build" ? env.VITE_CHAT_BASE || "/chat/" : "/",
    plugins: [vue()],
    server: {
      host: "127.0.0.1",
      port: Number(env.CHAT_PORT || 8852),
      strictPort: true,
      proxy,
    },
    preview: {
      host: "127.0.0.1",
      port: Number(env.CHAT_PORT || 8852),
      strictPort: true,
      proxy,
    },
  };
});
