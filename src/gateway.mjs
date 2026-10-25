import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function normalizeGatewayURL(input, { allowRemote = false } = {}) {
  let url;
  try { url = new URL(String(input).trim()); } catch { throw new Error('请输入有效的 HTTP(S) Gateway 地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
      url.search || url.hash || !/^\/(?:v1\/?|)$/.test(url.pathname)) {
    throw new Error('Gateway 地址必须是主机地址或 /v1，且不含账号、查询参数和片段。');
  }
  if (!LOOPBACK.has(url.hostname) && (!allowRemote || url.protocol !== 'https:')) {
    throw new Error('非回环 Gateway 只能使用 HTTPS 且必须明确配置 Key。');
  }
  return url.origin + '/v1';
}

export function gatewaySettings(input) {
  const key = String(input?.key ?? '');
  const url = normalizeGatewayURL(input?.url, { allowRemote: !!key });
  if (!key.trim()) throw new Error('Gateway Key 不能为空。');
  return { url, key };
}

function settingsPath(env) {
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'magpie', 'settings.json');
}

export async function discoverGateway(options = {}, env = process.env, fetcher = fetch) {
  let addr = options.gatewayURL || env.MAGPIE_FPD_GATEWAY_URL;
  const explicitKey = options.gatewayKey || env.MAGPIE_FPD_GATEWAY_KEY;
  if (!addr) {
    let port = 3425;
    try {
      const raw = JSON.parse(await readFile(settingsPath(env), 'utf8'));
      if (Number.isInteger(raw.port) && raw.port >= 1 && raw.port <= 65535) port = raw.port;
    } catch {}
    addr = env.MAGPIE_ADDR || `127.0.0.1:${port}`;
    if (addr.startsWith('0.0.0.0:')) addr = '127.0.0.1:' + addr.slice(8);
    if (addr.startsWith('[::]:')) addr = '[::1]:' + addr.slice(5);
    if (addr.startsWith(':')) addr = '127.0.0.1' + addr;
    if (!/^https?:\/\//.test(addr)) addr = 'http://' + addr;
  }
  let url;
  try {
    url = new URL(addr);
    if (!LOOPBACK.has(url.hostname) && !explicitKey) return null;
    url = normalizeGatewayURL(addr, { allowRemote: !!explicitKey });
  } catch { return null; }
  const key = explicitKey || 'magpie';
  try {
    const response = await fetcher(url + '/models', {
      headers: { Authorization: `Bearer ${key}` },
      redirect: 'error', signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    const body = await response.json();
    if (!Array.isArray(body?.data)) return null;
    return { url, key };
  } catch { return null; }
}

export async function listModels(config, fetcher = fetch) {
  const { url, key } = gatewaySettings(config);
  const response = await fetcher(url + '/models', {
    headers: { Authorization: `Bearer ${key}` },
    redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Gateway 模型列表请求失败 (HTTP ${response.status})。`);
  const raw = await response.text();
  if (raw.length > 2_000_000) throw new Error('Gateway 模型列表过大。');
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error('Gateway 返回了无效 JSON。'); }
  if (!Array.isArray(data?.data)) throw new Error('Gateway 模型列表格式异常。');
  return [...new Set(data.data.map(item => item?.id).filter(id =>
    typeof id === 'string' && id.length <= 256 &&
    /^[^\s\x00-\x1f]+\/[^\s\x00-\x1f]+$/.test(id) &&
    !/^(?:group|auto|quality-probe)\//.test(id),
  ))].slice(0, 2000).sort();
}
