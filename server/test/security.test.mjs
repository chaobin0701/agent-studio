import assert from 'node:assert/strict';
import test from 'node:test';
import { SecurityRateLimitService } from '../dist/security/security-rate-limit.service.js';
import { normalizeError } from '../dist/security/error-response.js';

test('body-parser size errors remain safe 413s rather than retryable server errors; arbitrary status objects are not trusted',()=>{
 const error=Object.assign(new Error('PRIVATE_BODY'),{type:'entity.too.large',status:413,body:'PRIVATE_BODY'});
 const result=normalizeError(error,'req-body');
 assert.equal(result.status,413);assert.equal(result.body.error.code,'payload_too_large');assert.doesNotMatch(JSON.stringify(result),/PRIVATE_BODY/);
 assert.equal(normalizeError({type:'entity.too.large',status:413,message:'forged'},'req').status,500);
 assert.equal(normalizeError(Object.assign(new Error('unrelated'),{status:413}),'req').status,500);
});
import { redact } from '../dist/security/redaction.js';
import { HttpException } from '@nestjs/common';
import { publicIntegrationError } from '../dist/integrations/quota-error.js';

test('security limiter enforces configured limits across calls and returns a stable error body', async () => {
  // Exercise a small explicit threshold rather than tying this test to deployment defaults.
  const limiter = new SecurityRateLimitService({ security: { chatWindowLimit: 10, documentUploadLimit: 10 } });
  for (let i = 0; i < 10; i += 1) await limiter.run('chat', 'visitor', async () => 'ok');
  await assert.rejects(() => limiter.run('chat', 'visitor', async () => 'no'), (error) => {
    assert.equal(error.getStatus(), 429);
    assert.deepEqual(error.getResponse(), { code: 'rate_limit_exceeded', message: '请求过于频繁，请稍后重试。' });
    return true;
  });
  for (let i = 0; i < 10; i += 1) await limiter.run('document-upload', 'admin-ip', async () => 'ok');
  await assert.rejects(() => limiter.run('document-upload', 'admin-ip', async () => 'no'), (error) => error.getStatus() === 429);
});

test('error normalization hides unexpected server details', () => {
  const result = normalizeError(new Error('database password=secret'), 'req-1');
  assert.equal(result.status, 500);
  assert.deepEqual(result.body, { error: { code: 'internal_error', message: '服务暂时不可用，请稍后重试。' }, requestId: 'req-1' });
});

test('quota errors retain only safe retry metadata, not arbitrary exception details', () => {
  const result=normalizeError(new HttpException({code:'daily_token_quota_exceeded',message:'今日额度已用完',retryAt:'2026-10-09T00:00:00+08:00',apiKey:'private'},429),'req-1');
  assert.equal(result.body.error.retryAt,'2026-10-08T16:00:00.000Z');
  assert.equal(JSON.stringify(result.body).includes('private'),false);
  assert.equal(JSON.stringify(publicIntegrationError(new HttpException({code:'daily_token_quota_exceeded',message:'额度不足',retryAt:'2026-10-09T00:00:00Z',apiKey:'private'},429))).includes('private'),false);
  for(const retryAt of ['not-a-date','secret-key',{},'9999-99-99T00:00:00Z'])assert.equal(normalizeError(new HttpException({retryAt},429),'req').body.error.retryAt,undefined);
  assert.equal(normalizeError(new HttpException({retryAt:'2026-10-09T00:00:00Z'},500),'req').body.error.retryAt,undefined);
});

test('redaction removes credential and prompt fields', () => {
  assert.deepEqual(redact({ authorization: 'Bearer secret', password: 'pw', prompt: 'private', status: 'ok' }), {
    authorization: '[REDACTED]', password: '[REDACTED]', prompt: '[REDACTED]', status: 'ok',
  });
});

test('platform work shares the expensive-work ceiling with browser chat and always releases it', async () => {
  const limiter = new SecurityRateLimitService({ security: { chatConcurrency: 1, chatWindowLimit: 10 } });
  let release;
  const running = limiter.runConcurrent('chat', () => new Promise(resolve => { release = resolve; }));
  await assert.rejects(limiter.run('chat', 'browser', async () => 'blocked'), e => e.getStatus() === 429);
  await assert.rejects(limiter.runConcurrent('chat', async () => 'blocked'), e => e.getStatus() === 429);
  release('done'); await running;
  await assert.rejects(limiter.runConcurrent('chat', async () => { throw new Error('failure'); }));
  assert.equal(await limiter.runConcurrent('chat', async () => 'released'), 'released');
});

test('structured output failures retain only bounded issues and a safe message at HTTP boundary',()=>{
 const result=normalizeError(new HttpException({code:'output_validation_failed',message:'PRIVATE_PROVIDER_BODY',issues:[{path:'$.structured.count',message:'字段类型不匹配',value:'PRIVATE_RESULT'}],schema:'PRIVATE_SCHEMA'},502),'req-output');
 assert.equal(result.status,502);assert.equal(result.body.error.code,'output_validation_failed');assert.deepEqual(result.body.error.issues,[{path:'$.structured.count',message:'字段类型不匹配'}]);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_/);
});
