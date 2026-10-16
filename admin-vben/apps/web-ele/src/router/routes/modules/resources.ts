import type { RouteRecordRaw } from "vue-router";
const routes: RouteRecordRaw[] = (["agent", "skill", "tool"] as const).flatMap(
  (kind, i) => [
    {
      path: `/${kind}s`,
      name: `${kind}List`,
      component: () => import("#/views/resources/index.vue"),
      meta: {
        title: { agent: "Agent 管理", skill: "Skill 管理", tool: "Tool 管理" }[
          kind
        ],
        icon: "lucide:boxes",
        order: i === 0 ? 2 : i + 3,
        authority: ["agent_config.read", "agent_config.manage"],
        resourceKind: kind,
      },
    },
    {
      path: `/${kind}s/:id`,
      name: `${kind}Detail`,
      component: () => import("#/views/resources/index.vue"),
      meta: {
        title: `${{ agent: "Agent", skill: "Skill", tool: "Tool" }[kind]} 详情`,
        hideInMenu: true,
        activePath: `/${kind}s`,
        authority: ["agent_config.read", "agent_config.manage"],
        resourceKind: kind,
      },
    },
  ],
);
export default routes;
