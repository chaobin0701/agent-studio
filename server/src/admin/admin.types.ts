export interface AdminPrincipal {
  id: number;
  email: string | null;
  username?: string | null;
  displayName: string;
}

export interface AdminRequest {
  headers: { authorization?: string; 'x-workspace-id'?: string | string[] };
  path?: string;
  workspaceId?: number;
  workspacePermissionCodes?: string[];
  admin?: AdminPrincipal;
}
