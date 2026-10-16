import type { RouteRecordRaw } from "vue-router";
const routes: RouteRecordRaw[] = [
  {
    path: "/knowledge-bases",
    name: "KnowledgeBases",
    component: () => import("#/views/knowledge/index.vue"),
    meta: {
      title: "知识库管理",
      icon: "lucide:book-open",
      order: 8,
      authority: ["documents.read", "knowledge_bases.manage"],
    },
  },
  {
    path: "/knowledge-bases/:id",
    name: "KnowledgeBaseDetail",
    component: () => import("#/views/knowledge/index.vue"),
    meta: {
      title: "知识库详情",
      hideInMenu: true,
      activePath: "/knowledge-bases",
      authority: ["documents.read", "knowledge_bases.manage"],
    },
  },
];
export default routes;
