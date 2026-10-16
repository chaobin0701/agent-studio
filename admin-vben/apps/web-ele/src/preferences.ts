import { defineOverridesPreferences } from "@vben/preferences";

/**
 * @description 项目配置文件
 * 只需要覆盖项目中的一部分配置，不需要的配置不用覆盖，会自动使用默认配置
 * !!! 更改配置后请清空缓存，否则可能不生效
 */
export const overridesPreferences = defineOverridesPreferences({
  // overrides
  app: {
    name: import.meta.env.VITE_APP_TITLE || "Agent Studio",
    defaultHomePath: "/overview",
    defaultAvatar: "/logo.svg",
    authPageLayout: "panel-center",
    enableCheckUpdates: false,
    enableRefreshToken: false,
    loginExpiredMode: "page",
  },
  copyright: { enable: false },
  logo: { source: "/logo.svg" },
  tabbar: { keepAlive: false, persist: false },
  theme: { mode: "light", colorPrimary: "hsl(174 67% 25%)" },
  widget: { notification: false, globalSearch: false },
});
