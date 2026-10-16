import { HttpException, HttpStatus } from '@nestjs/common';

export type ErrorResponse = { error: { code: string; message: string; retryAt?: string; issues?:{path:string;message:string}[] }; requestId: string };

export function normalizeError(exception: unknown, requestId: string): { status: number; body: ErrorResponse } {
  // Express/body-parser errors are not Nest HttpExceptions. Recognize only its
  // bounded body rejection; never expose parser messages, payloads or headers.
  if (exception instanceof Error && (exception as Error & {type?:unknown;status?:unknown}).type === 'entity.too.large' && (exception as Error & {status?:unknown}).status === 413) {
    return {status:413,body:{error:{code:'payload_too_large',message:'请求内容过大，请减少资料内容或文件数量后重试。'},requestId}};
  }
  const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
  const response = exception instanceof HttpException ? exception.getResponse() : undefined;
  const rawMessage = typeof response === 'string'
    ? response
    : response && typeof response === 'object' && 'message' in response
      ? (response as { message?: unknown }).message
      : undefined;
  const message = status >= 500 ? '服务暂时不可用，请稍后重试。' : Array.isArray(rawMessage) ? rawMessage.join('; ') : typeof rawMessage === 'string' ? rawMessage : '请求无法处理';
  const code = response && typeof response === 'object' && 'code' in response && typeof (response as { code?: unknown }).code === 'string'
    ? (response as { code: string }).code
    : status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 429 ? 'rate_limit_exceeded' : status >= 500 ? 'internal_error' : 'bad_request';
  if(['output_validation_failed','output_schema_invalid','output_contract_conflict'].includes(code) && response && typeof response==='object') {
    const issues='issues' in response && Array.isArray(response.issues)?response.issues.filter((i:any)=>i&&typeof i.path==='string'&&typeof i.message==='string').slice(0,12).map((i:any)=>({path:i.path.slice(0,240),message:i.message.slice(0,240)})):[];
    return {status,body:{error:{code,message:code==='output_validation_failed'?'模型结果未通过输出规范校验，本轮执行失败。':message,issues},requestId}};
  }
  const rawRetryAt = status === 429 && response && typeof response === 'object' && 'retryAt' in response ? response.retryAt : undefined;
  const retryAt = typeof rawRetryAt === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?$/.test(rawRetryAt) && Number.isFinite(Date.parse(rawRetryAt)) ? new Date(rawRetryAt).toISOString() : undefined;
  return { status, body: { error: { code, message, ...(retryAt ? { retryAt } : {}) }, requestId } };
}
