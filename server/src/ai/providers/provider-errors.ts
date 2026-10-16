export type ProviderErrorKind =
  | "timeout"
  | "rate_limit"
  | "quota"
  | "server"
  | "connection"
  | "auth"
  | "context_length"
  | "model_not_found"
  | "invalid_request"
  | "invalid_response"
  | "unsupported_response_format";

export interface ProviderErrorOptions {
  retryAfterMs?: number | null;
  errorKind?: ProviderErrorKind;
}

export class ProviderError extends Error {
  diagnostics?: { message?: string; code?: string };
  readonly retryAfterMs: number | null;
  readonly errorKind: ProviderErrorKind;

  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly status?: number,
    options?: ProviderErrorOptions,
  ) {
    super(message);
    this.name = "ProviderError";
    this.retryAfterMs = options?.retryAfterMs ?? null;
    this.errorKind = options?.errorKind ?? defaultErrorKind(code);
  }
}

/** Expose only short supplier error fields; never return full provider payloads. */
export function providerDiagnostics(
  payload: unknown,
  apiKey: string,
): { message?: string; code?: string } {
  const error = (payload as { error?: unknown } | null)?.error;
  if (!error || typeof error !== "object") return {};
  const fields = error as { message?: unknown; code?: unknown };
  const clean = (value: unknown) => {
    if (typeof value !== "string") return undefined;
    let text = apiKey ? value.split(apiKey).join("[redacted]") : value;
    text = text
      .replace(/Bearer\s+\S+|sk-[\w-]+/gi, "[redacted]")
      .replace(
        /((?:api[_-]?key|authorization|token|secret|password)\s*[=:]\s*)[^\s,;]+/gi,
        "$1[redacted]",
      );
    return text.slice(0, 800);
  };
  return { message: clean(fields.message), code: clean(fields.code) };
}

function defaultErrorKind(code: string): ProviderErrorKind {
  switch (code) {
    case "provider_timeout":
      return "timeout";
    case "provider_rate_limit":
      return "rate_limit";
    case "provider_quota_exhausted":
      return "quota";
    case "provider_authentication":
      return "auth";
    case "provider_context_length":
      return "context_length";
    case "provider_model_not_found":
      return "model_not_found";
    case "provider_invalid_request":
      return "invalid_request";
    case "provider_invalid_response":
      return "invalid_response";
    case "provider_unsupported_response_format":
      return "unsupported_response_format";
    default:
      return "server";
  }
}

export class ProviderAuthenticationError extends ProviderError {
  constructor(status?: number) {
    super(
      "Model provider authentication failed",
      "provider_authentication",
      false,
      status,
      { errorKind: "auth" },
    );
  }
}

export class ProviderRateLimitError extends ProviderError {
  constructor(status = 429, retryAfterMs?: number | null) {
    super(
      "Model provider rate limit exceeded",
      "provider_rate_limit",
      true,
      status,
      {
        retryAfterMs,
        errorKind: "rate_limit",
      },
    );
  }
}

export class ProviderQuotaExhaustedError extends ProviderError {
  constructor(status = 429) {
    super(
      "Model provider quota or balance is exhausted",
      "provider_quota_exhausted",
      false,
      status,
      {
        errorKind: "quota",
      },
    );
  }
}

export class ProviderTimeoutError extends ProviderError {
  constructor() {
    super(
      "Model provider request timed out",
      "provider_timeout",
      true,
      undefined,
      { errorKind: "timeout" },
    );
  }
}

export class ProviderContextLengthError extends ProviderError {
  constructor(status?: number) {
    super(
      "Model provider context is too long",
      "provider_context_length",
      false,
      status,
      {
        errorKind: "context_length",
      },
    );
  }
}

export class ProviderModelNotFoundError extends ProviderError {
  constructor(status?: number) {
    super(
      "Model provider model was not found",
      "provider_model_not_found",
      false,
      status,
      {
        errorKind: "model_not_found",
      },
    );
  }
}

export class ProviderInvalidRequestError extends ProviderError {
  constructor(status = 400) {
    super(
      "Model provider rejected the request parameters",
      "provider_invalid_request",
      false,
      status,
      {
        errorKind: "invalid_request",
      },
    );
  }
}

export class ProviderUnavailableError extends ProviderError {
  constructor(
    status?: number,
    retryAfterMs?: number | null,
    errorKind: ProviderErrorKind = "server",
  ) {
    super(
      "Model provider is temporarily unavailable",
      "provider_unavailable",
      true,
      status,
      {
        retryAfterMs,
        errorKind,
      },
    );
  }
}

export class ProviderInvalidResponseError extends ProviderError {
  constructor() {
    super(
      "Model provider returned an invalid response",
      "provider_invalid_response",
      false,
      undefined,
      {
        errorKind: "invalid_response",
      },
    );
  }
}

export class ProviderOutputTruncatedError extends ProviderError {
  constructor() {
    super(
      "Model output reached the configured token limit",
      "model_output_truncated",
      false,
      undefined,
      { errorKind: "invalid_response" },
    );
  }
}
export class ProviderContentFilteredError extends ProviderError {
  constructor() {
    super(
      "Model output was filtered by the provider",
      "model_content_filtered",
      false,
      undefined,
      { errorKind: "invalid_response" },
    );
  }
}

export class ProviderUnsupportedResponseFormatError extends ProviderError {
  constructor(status?: number) {
    super(
      "Model provider does not support the requested response format",
      "provider_unsupported_response_format",
      false,
      status,
      { errorKind: "unsupported_response_format" },
    );
  }
}

const NON_RETRYABLE_429_MARKERS = [
  "insufficient_quota",
  "insufficient quota",
  "quota_exceeded",
  "quota exceeded",
  "quota_exhausted",
  "quota exhausted",
  "billing_hard_limit_reached",
  "billing hard limit",
  "billing_not_active",
  "billing not active",
  "insufficient_balance",
  "insufficient balance",
  "credit_balance_too_low",
  "credit balance too low",
  "payment_required",
  "payment required",
  "out of credits",
  "out of quota",
  "exceeded your current quota",
  "账户余额不足",
  "余额不足",
  "欠费",
] as const;

export function isNonRetryableQuota429(payload: unknown): boolean {
  const text = (
    typeof payload === "string" ? payload : JSON.stringify(payload ?? "")
  ).toLowerCase();
  if (!text) return false;
  return NON_RETRYABLE_429_MARKERS.some((marker) => text.includes(marker));
}

export function parseRetryAfterMs(
  headers?: { get?: (name: string) => string | null } | null,
): number | null {
  const raw = headers?.get?.("retry-after")?.trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.ceil(seconds * 1000), 60_000);
  }
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? Math.min(delta, 60_000) : 0;
  }
  return null;
}
