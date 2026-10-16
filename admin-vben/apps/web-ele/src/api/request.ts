import { useAppConfig } from "@vben/hooks";
import { RequestClient } from "@vben/request";
import { useAccessStore } from "@vben/stores";

import { ElMessage } from "element-plus";

import { useAuthStore } from "#/store";
import { useWorkspaceStore } from "#/store/workspace";
import { readStreamError } from "./event-stream";

const { apiURL } = useAppConfig(import.meta.env, import.meta.env.PROD);

// Public defaults must survive a fresh worktree: local .env files are not tracked.
export const requestClient = new RequestClient({
  baseURL: apiURL?.trim() || "/api/admin",
  timeout: 120_000,
});

requestClient.addRequestInterceptor({
  fulfilled: (config) => {
    const token = useAccessStore().accessToken;
    if (token) config.headers.Authorization = `Bearer ${token}`;
    const workspace = useWorkspaceStore();
    if (workspace.id) config.headers["X-Workspace-ID"] = String(workspace.id);
    (config as any).workspaceGeneration = workspace.generation;
    return config;
  },
});

requestClient.addResponseInterceptor({
  fulfilled: (response) => {
    if (
      (response.config as any).workspaceGeneration !==
      useWorkspaceStore().generation
    ) {
      if (response.data instanceof ReadableStream)
        void response.data.cancel().catch(() => {});
      throw new Error("工作区已切换");
    }
    if (
      response.config.responseType === "stream" &&
      !String(response.headers["content-type"]).includes("text/event-stream")
    ) {
      if (response.data instanceof ReadableStream)
        void response.data.cancel().catch(() => {});
      throw new Error("服务器未返回执行事件流，请检查服务或代理配置。");
    }
    return response.data;
  },
  rejected: async (error: any) => {
    if (error.code === "ERR_CANCELED") return Promise.reject(error);
    if (
      error.config &&
      error.config.workspaceGeneration !== useWorkspaceStore().generation
    ) {
      if (error.response?.data instanceof ReadableStream)
        void error.response.data.cancel().catch(() => {});
      return Promise.reject(error);
    }
    if (error.response?.data instanceof ReadableStream)
      error.response.data = await readStreamError(error.response.data);
    // Reading an error body is asynchronous; do not log out or toast a newer
    // workspace/session because an old stream finished late.
    if (
      error.config &&
      error.config.workspaceGeneration !== useWorkspaceStore().generation
    )
      return Promise.reject(error);
    const isLogin = error.config?.url?.endsWith("/auth/login");
    if (
      error.response?.status === 401 &&
      !isLogin &&
      useAccessStore().accessToken
    ) {
      await useAuthStore().logout();
      ElMessage.error("登录已失效，请重新登录");
    } else {
      const message =
        error.response?.data?.error?.message ?? error.response?.data?.message;
      ElMessage.error(
        isLogin && error.response?.status === 401
          ? "账号或密码错误"
          : Array.isArray(message)
            ? message.join("；")
            : typeof message === "string"
              ? message
              : isLogin
                ? "登录失败，请检查账号和密码"
                : "请求失败，请稍后重试",
      );
    }
    return Promise.reject(error);
  },
});
