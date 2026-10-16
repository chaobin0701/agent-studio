import type { RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  {
    path: '/overview',
    name: 'Overview',
    component: () => import('#/views/overview/index.vue'),
    meta: { title: '管理首页', icon: 'lucide:layout-dashboard', order: 0 },
  },
];

export default routes;
