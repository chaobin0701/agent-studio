import { join } from 'node:path';
import { AppConfigService } from '../config/config.service';
import { currentWorkspaceId } from '../workspaces/workspace-context';

export function documentsDir(config: AppConfigService): string {
  return join(config.uploadRoot, 'documents', String(currentWorkspaceId()));
}

export function documentPath(storageKey: string, config: AppConfigService): string {
  const scoped=/^(\d+)\/([a-f0-9-]{36}\.(md|docx|pdf))$/.exec(storageKey);
  if (scoped) {
    if(Number(scoped[1])!==currentWorkspaceId())throw new Error('Invalid workspace storage key');
  } else if(currentWorkspaceId()!==1 || !/^[a-f0-9-]{36}\.(md|docx|pdf)$/.test(storageKey)) throw new Error('Invalid storage key');
  return join(config.uploadRoot, 'documents', storageKey);
}
