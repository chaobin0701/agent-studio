import { OutputContractError } from "@agent-studio/output-contract";
import { HttpException } from "@nestjs/common";
import {
  formatRetryExhaustedMessage,
  type LlmErrorKind,
} from "../chat/llm.service";

export function quotaExceeded(
  code: string,
  message: string,
  retryAt: string,
): HttpException {
  return new HttpException({ statusCode: 429, code, message, retryAt }, 429);
}

export function hasRetryErrorMetadata(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  return (
    record.retryExhausted === true ||
    record.errorCode === "provider_quota_exhausted" ||
    record.code === "provider_quota_exhausted"
  );
}

export function publicIntegrationError(error: unknown) {
  const outputMessages: Record<string, string> = {
    output_validation_failed:
      "模型结果未通过输出规范校验，本轮执行失败；不会自动重跑任务。",
    output_schema_invalid: "输出规范无效，请检查 Agent 配置。",
    output_contract_conflict: "请求不能覆盖 Agent 已配置的输出规范。",
  };
  if (error instanceof OutputContractError)
    return {
      status: 502,
      code: error.code,
      message:
        outputMessages[error.code] ?? outputMessages.output_validation_failed,
      issues: error.issues,
    };
  const outputBody =
    error instanceof HttpException ? error.getResponse() : null;
  if (
    outputBody &&
    typeof outputBody === "object" &&
    "code" in outputBody &&
    typeof outputBody.code === "string" &&
    Object.hasOwn(outputMessages, outputBody.code)
  ) {
    const issues =
      "issues" in outputBody && Array.isArray(outputBody.issues)
        ? outputBody.issues
            .filter(
              (i: any) =>
                i &&
                typeof i.path === "string" &&
                typeof i.message === "string",
            )
            .slice(0, 12)
            .map((i: any) => ({
              path: i.path.slice(0, 240),
              message: i.message.slice(0, 240),
            }))
        : [];
    return {
      status: error instanceof HttpException ? error.getStatus() : 502,
      code: outputBody.code,
      message: outputMessages[outputBody.code],
      issues,
    };
  }
  const status = error instanceof HttpException ? error.getStatus() : 503;
  const body = error instanceof HttpException ? error.getResponse() : null;
  const agentMessages: Record<string, string> = {
    agent_budget_exceeded: "本次任务已达到执行上限，请缩小问题范围后重试。",
    agent_timeout: "本次任务处理超时，请缩小问题范围后重试。",
    run_cancelled: "本次请求已取消。",
    model_output_truncated:
      "模型输出达到长度上限，本轮未完成，请缩小问题范围或联系管理员调整输出上限。",
    model_content_filtered: "模型服务未能完成本次回答，请调整问题后重试。",
    artifact_outputs_disabled:
      "此 Agent 未启用文件产物，请联系管理员调整发布配置。",
    artifact_output_invalid:
      "生成的文件产物无效或未正确选中，请调整任务后重试。",
    artifact_limit_exceeded:
      "文件产物超过数量或大小上限，请缩小文件内容后重试。",
    artifact_storage_limit:
      "工作区文件产物存储已达到上限，请清理已有文件后重试。",
  };
  if (
    body &&
    typeof body === "object" &&
    "code" in body &&
    typeof body.code === "string" &&
    Object.hasOwn(agentMessages, body.code)
  ) {
    return { status, code: body.code, message: agentMessages[body.code] };
  }
  if (
    status === 502 &&
    body &&
    typeof body === "object" &&
    "code" in body &&
    body.code === "model_protocol_error"
  )
    return {
      status,
      code: "model_protocol_error",
      message: "模型响应格式异常，本轮未完成，请稍后重试。",
    };
  if (
    status === 429 &&
    body &&
    typeof body === "object" &&
    "code" in body &&
    typeof body.code === "string" &&
    "retryAt" in body &&
    typeof body.retryAt === "string"
  ) {
    return {
      status,
      code: body.code,
      retryAt: body.retryAt,
      message:
        "message" in body && typeof body.message === "string"
          ? body.message
          : "当前访问较多，请稍后重试。",
    };
  }
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const code =
      typeof record.errorCode === "string"
        ? record.errorCode
        : typeof record.code === "string"
          ? record.code
          : undefined;
    if (code?.startsWith("artifact_") && Object.hasOwn(agentMessages, code))
      return { status, code, message: agentMessages[code] };
    if (code === "provider_quota_exhausted") {
      return {
        status: 503,
        code: "provider_quota_exhausted",
        message: "模型服务账户额度已耗尽，请联系管理员检查模型配置。",
      };
    }
    if (record.retryExhausted === true) {
      const attempts =
        typeof record.attempts === "number" ? record.attempts : 4;
      const maxRetries = Math.max(1, attempts - 1);
      const errorKind = (
        typeof record.errorKind === "string" ? record.errorKind : "server"
      ) as LlmErrorKind;
      return {
        status: 503,
        code: "model_retry_exhausted",
        errorKind,
        attempts,
        retryExhausted: true,
        message: formatRetryExhaustedMessage("model", errorKind, maxRetries),
      };
    }
  }
  return {
    status,
    message:
      status === 429
        ? "当前访问较多，请稍后重试。"
        : "回答暂时未能完成，请使用新的请求 ID 重试。",
  };
}
