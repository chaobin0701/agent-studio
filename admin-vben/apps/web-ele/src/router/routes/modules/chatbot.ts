import type { RouteRecordRaw } from "vue-router";
const routes: RouteRecordRaw[] = [
  {
    path: "/agent-chat",
    name: "AgentChatbot",
    component: () => import("#/views/chatbot/index.vue"),
    meta: {
      title: "Agent 对话",
      icon: "lucide:messages-square",
      order: 2.5,
      authority: ["agent_chat.use"],
    },
  },
];
export default routes;
