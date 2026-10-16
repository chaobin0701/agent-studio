export const APPLICATION_LIMIT_KEYS = ['requestsPerMinute', 'concurrency', 'dailyRequests', 'dailyTokenLimit'] as const;
export type ApplicationLimitKey = typeof APPLICATION_LIMIT_KEYS[number];
export type ApplicationLimitSettings = Record<ApplicationLimitKey, boolean>;
export const DISABLED_APPLICATION_LIMITS: ApplicationLimitSettings = {
  requestsPerMinute: false, concurrency: false, dailyRequests: false, dailyTokenLimit: false,
};

/** Missing switches identify an old configuration, never an implicit new default. */
export function applicationLimit(
  app: Partial<Record<ApplicationLimitKey,number|string|null>> & { limitSettings?: Partial<ApplicationLimitSettings> },
  key: ApplicationLimitKey,
): number | null {
  if (app.limitSettings?.[key] === false) return null;
  const value = app[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value :
    typeof value === 'string' && Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
}

/** Emergency service guards are separate from optional tenant business quotas. */
export const APPLICATION_SAFETY = { requestsPerMinute: 10000, concurrency: 100 } as const;
