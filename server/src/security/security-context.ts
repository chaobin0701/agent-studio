import { randomUUID } from 'node:crypto';

export function requestId(): string {
  return randomUUID();
}

export function safePath(value: string): string {
  const path = value.split('?')[0] || '/';
  return path.length <= 200 ? path : `${path.slice(0, 197)}...`;
}

export function safeIdentity(adminId: number | undefined): string {
  return Number.isSafeInteger(adminId) ? `admin:${adminId}` : 'anonymous';
}
