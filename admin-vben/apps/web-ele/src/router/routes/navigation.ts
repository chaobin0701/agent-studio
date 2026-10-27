import type { RouteRecordRaw } from "vue-router";

/** Group navigation without changing resource URLs, guards or deep links. */
export function groupManagementRoutes(
  routes: RouteRecordRaw[],
): RouteRecordRaw[] {
  const groups = [
    {
      name: "AgentWorkspace",
      path: "/agent-workspace",
      title: "Agent",
      icon: "lucide:bot",
      paths: ["/agents", "/agent-playground", "/integrations"],
    },
    {
      name: "ResourceWorkspace",
      path: "/resources",
      title: "资源",
      icon: "lucide:library",
      paths: ["/prompts", "/skills", "/tools", "/mcp", "/knowledge-bases"],
    },
    {
      name: "ModelWorkspace",
      path: "/models",
      title: "模型",
      icon: "lucide:cpu",
      paths: ["/models/llm", "/models/embedding"],
    },
    {
      name: "SettingsWorkspace",
      path: "/settings",
      title: "设置",
      icon: "lucide:settings",
      paths: ["/workspaces", "/system/users", "/system/roles", "/system-mcp"],
    },
  ];
  const assigned = new Set<RouteRecordRaw>();
  const result = groups.map((group, index): RouteRecordRaw => {
    const children = routes.filter((route) =>
      group.paths.some(
        (path) => route.path === path || route.path.startsWith(`${path}/`),
      ),
    );
    children.forEach((route) => assigned.add(route));
    return {
      name: group.name,
      path: group.path,
      meta: {
        title: group.title,
        icon: group.icon,
        order: index === 3 ? 5 : index + 1,
        authority: children.some((route) => !route.meta?.authority)
          ? undefined
          : [
              ...new Set(
                children.flatMap((route) => route.meta?.authority ?? []),
              ),
            ],
      },
      children,
    };
  });
  return [...routes.filter((route) => !assigned.has(route)), ...result];
}
