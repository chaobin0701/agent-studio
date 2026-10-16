export interface PlatformRole {
  id: number;
  code: string;
  name: string;
  isSystem: boolean;
  permissionCodes: string[];
}

export interface PlatformUser {
  id: number;
  username: null | string;
  email: null | string;
  displayName: string;
  disabledAt: null | string;
  roles: Array<{ id: number; code: string }>;
}

export interface Permission {
  code: string;
  description: string;
}

export const workspaceRoles = [
  { value: "owner", label: "所有者" },
  { value: "manager", label: "管理员" },
  { value: "reader", label: "只读成员" },
  { value: "custom", label: "自定义权限" },
];

export interface UserWorkspace {
  id: number;
  name: string;
  enabled: boolean;
  role: null | string;
  permissionCodes: null | string[];
}

// Platform grants come from platform roles, not effective workspace permissions.
export function grantablePermissions(
  roles: PlatformRole[],
  actorRoles: string[],
) {
  return new Set(
    roles
      .filter((role) => actorRoles.includes(role.code))
      .flatMap((role) => role.permissionCodes),
  );
}

export function canAssignRole(
  role: PlatformRole,
  roles: PlatformRole[],
  actorRoles: string[],
) {
  const grants = grantablePermissions(roles, actorRoles);
  return (
    (!role.isSystem || actorRoles.includes("super_admin")) &&
    role.permissionCodes.every((code) => grants.has(code))
  );
}

export function loginIdentity(value: string) {
  const identity = value.trim().toLowerCase();
  return identity.includes("@") ? { email: identity } : { username: identity };
}

export function passwordError(value: string) {
  if (value.length < 10 || value.length > 72) return "密码需为 10–72 个字符";
  if (new TextEncoder().encode(value).length > 72)
    return "密码的 UTF-8 长度不能超过 72 字节，请减少中文或特殊字符";
  return "";
}

export function filterUsers(
  users: PlatformUser[],
  query: string,
  status: string,
) {
  const search = query.trim().toLowerCase();
  return users.filter(
    (user) =>
      (!status ||
        (status === "disabled" ? !!user.disabledAt : !user.disabledAt)) &&
      [user.displayName, user.username, user.email, String(user.id)].some(
        (value) => value?.toLowerCase().includes(search),
      ),
  );
}
