import { AsyncLocalStorage } from 'node:async_hooks';

export type WorkspaceContext = { workspaceId: number; adminId?: number; permissionCodes?: string[] };
export const workspaceContext = new AsyncLocalStorage<WorkspaceContext>();
export const DEFAULT_WORKSPACE_ID = 1;
export function currentWorkspaceId(): number {
  return workspaceContext.getStore()?.workspaceId ?? DEFAULT_WORKSPACE_ID;
}
export function selectWorkspace(workspaceId: number, extra: Partial<WorkspaceContext> = {}): void {
  if (!Number.isSafeInteger(workspaceId) || workspaceId < 1) throw new Error('Invalid workspace ID');
  const context = workspaceContext.getStore();
  if (!context) throw new Error('Workspace request context is missing');
  Object.assign(context, extra, { workspaceId });
}
export function inWorkspace<T>(workspaceId: number, task: () => T): T {
  if (!Number.isSafeInteger(workspaceId) || workspaceId < 1) throw new Error('Invalid workspace ID');
  return workspaceContext.run({ workspaceId }, task);
}
