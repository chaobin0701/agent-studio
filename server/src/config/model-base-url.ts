/** Platform presets are suggestions, not an endpoint allowlist. */
export function normalizeModelBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('请填写有效的 HTTP 或 HTTPS API 地址');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname)
    throw new Error('请填写有效的 HTTP 或 HTTPS API 地址');
  if (url.username || url.password || url.search || url.hash)
    throw new Error('API 地址不能包含用户名、密码、查询参数或片段，请将密钥填写在 API Key 中');
  return url.href.replace(/\/+$/, '');
}
