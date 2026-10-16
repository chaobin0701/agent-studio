import type { UserInfo } from '@vben/types';

import { requestClient } from '#/api/request';

export interface AdminIdentity {
  id: number;
  email: null | string;
  username: null | string;
  displayName: string;
  roles: Array<{ code: string; id: number; name: string }>;
  permissionCodes: string[];
  workspaceId?: number;
}

export function getAdminIdentityApi() {
  return requestClient.get<AdminIdentity>('/auth/me');
}

export function toUserInfo(admin: AdminIdentity): UserInfo {
  return {
    avatar: '',
    desc: admin.email || '',
    homePath: '/overview',
    realName: admin.displayName || admin.username || admin.email || String(admin.id),
    roles: admin.roles.map((role) => role.code),
    token: '',
    userId: String(admin.id),
    username: admin.username || admin.email || String(admin.id),
    email: admin.email,
    permissionCodes: admin.permissionCodes,
    workspaceId: admin.workspaceId,
  };
}
