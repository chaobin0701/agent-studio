import { defineConfig, viteCssLayerPlugin } from '@vben/vite-config';

import ElementPlus from 'unplugin-element-plus/vite';

export default defineConfig(async () => {
  return {
    // Element Plus uses CommonJS Day.js plugins. Let Vite pre-bundle the root
    // and deep imports together, rather than excluding them via Vben's ESM rewrite.
    application: { dayjs: false },
    vite: {
      optimizeDeps: {
        include: ['dayjs', 'dayjs/plugin/*.js', 'dayjs/locale/en', 'dayjs/locale/zh-cn'],
      },
      plugins: [
        // element-plus 的 css 包进 @layer el，使 Tailwind 工具类可覆盖组件样式
        viteCssLayerPlugin({ layerName: 'el', packageName: 'element-plus' }),
        ElementPlus({ format: 'esm' }),
      ],
      server: {
        host: '127.0.0.1',
        port: Number(process.env.ADMIN_PORT || 8085),
        strictPort: true,
        proxy: {
          '/api': {
            changeOrigin: true,
            target: process.env.API_PROXY_TARGET || 'http://127.0.0.1:3020',
          },
        },
      },
    },
  };
});
