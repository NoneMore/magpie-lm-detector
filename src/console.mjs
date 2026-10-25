import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, chmod, unlink } from 'node:fs/promises';
import { discoverGateway, gatewaySettings, listModels } from './gateway.mjs';
import { JobManager } from './jobs.mjs';

const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));
const TICKET_TTL = 10 * 60_000;
const SESSION_TTL = 12 * 60 * 60_000;
const rand = () => randomBytes(32).toString('hex');

function status(res, code, body, contentType = 'application/json; charset=utf-8', headers = {}) {
  res.writeHead(code, { 'Content-Type': contentType, 'Cache-Control': 'no-store', ...headers });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function fail(res, code, message) { status(res, code, { error: message }); }
function visibleConfig(c) {
  return { gatewayUrl: c?.url ?? '', hasGatewayKey: !!c?.key };
}
function configFile(options) {
  const root = options.dataDir || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'magpie-lm-detector');
  return path.join(root, 'config.json');
}
async function readConfig(file) {
  try {
    const c = JSON.parse(await readFile(file, 'utf8'));
    return gatewaySettings(c);
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    throw new Error(`无法加载检测器配置：${e.message}`);
  }
}
async function saveConfig(file, c) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + rand() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(c) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
    await chmod(file, 0o600);
  } catch (e) {
    await unlink(temporary).catch(() => {});
    throw e;
  }
}
async function readBody(req, maxBytes = 16384) {
  let size = 0;
  const chunks = [];
  for await (const piece of req) {
    size += piece.length;
    if (size > maxBytes) throw new Error('请求体超过大小限制。');
    chunks.push(piece);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error();
    return body;
  } catch { throw new Error('请求体必须是 JSON 对象。'); }
}

export async function startConsole(options = {}) {
  const file = configFile(options);
  let config = await readConfig(file);
  const tickets = new Map();
  const sessions = new Map();
  const jobs = new JobManager(options.detectorLoader || (async () => {
    const { loadDetector } = await import('lmfpd-sdk');
    return loadDetector({
      ...(options.dataSource || process.env.LMFPD_DATA_SOURCE
        ? { source: options.dataSource || process.env.LMFPD_DATA_SOURCE } : {}),
    });
  }));
  let origin;
  let discoveryTimer;
  let discovering = false;
  let closed = false;

  const clean = () => {
    for (const [key, exp] of tickets) if (exp < Date.now()) tickets.delete(key);
    for (const [key, exp] of sessions) if (exp < Date.now()) sessions.delete(key);
  };
  const readSession = req => {
    const m = /(?:^|;\s*)lmfpd_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '');
    return m && (sessions.get(m[1]) ?? 0) > Date.now() ? m[1] : null;
  };
  const getConfig = () => config;
  const tryDiscovery = async () => {
    if (config || discovering || closed) return;
    discovering = true;
    try {
      const found = await discoverGateway(options, process.env, options.fetcher || fetch);
      if (found && !config && !closed) {
        config = found;
        await saveConfig(file, found);
      }
    } catch { /* No gateway yet: the UI can still open for manual setup. */ }
    finally {
      discovering = false;
      if (!config && !closed) {
        discoveryTimer = setTimeout(tryDiscovery, 5000);
        discoveryTimer.unref?.();
      }
    }
  };

  const server = http.createServer(async (req, res) => {
    try {
      // Restricts DNS rebinding even though the server only listens on loopback.
      if (req.headers.host !== new URL(origin).host) return fail(res, 403, 'Host 不匹配。');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy',
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      const target = new URL(req.url, origin);
      const pathname = target.pathname;
      clean();
      if (req.method === 'GET' && /^\/open\/[a-f0-9]{64}$/.test(pathname)) {
        const ticket = pathname.slice('/open/'.length);
        const exp = tickets.get(ticket);
        tickets.delete(ticket); // one-time use, including expired tickets
        if (!exp || exp < Date.now()) return fail(res, 401, '链接已失效，请从 Magpie 重新打开控制台。');
        const session = rand();
        sessions.set(session, Date.now() + SESSION_TTL);
        status(res, 303, '', 'text/plain; charset=utf-8', {
          Location: '/',
          'Set-Cookie': `lmfpd_session=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}`,
        });
        return;
      }
      if (!readSession(req)) return fail(res, 401, '会话已失效，请从 Magpie 重新打开控制台。');
      // CSRF defense: session cookie AND an explicit custom header, plus Origin.
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        if (req.headers.origin !== origin || req.headers['x-lmfpd-console'] !== '1') {
          return fail(res, 403, '请求来源未获授权。');
        }
      }
      if (req.method === 'GET' && STATIC.has(pathname)) {
        const [name, mime] = STATIC.get(pathname);
        return status(res, 200, await readFile(path.join(WEB_DIR, name)), mime);
      }
      if (req.method === 'GET' && pathname === '/api/state') {
        return status(res, 200, { config: visibleConfig(config), jobs: jobs.list() });
      }
      if (req.method === 'GET' && pathname === '/api/models') {
        if (!config) return fail(res, 409, '尚未配置 Gateway，请先设置连接。');
        return status(res, 200, { models: await listModels(config, options.fetcher || fetch) });
      }
      if (req.method === 'GET' && pathname === '/api/reference') {
        return status(res, 200, await jobs.info());
      }
      if (req.method === 'POST' && pathname === '/api/config') {
        const body = await readBody(req);
        const explicitKey = typeof body.gatewayKey === 'string' ? body.gatewayKey : '';
        const next = gatewaySettings({ url: body.gatewayUrl, key: explicitKey || getConfig()?.key || '' });
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(next.url).hostname) &&
            !explicitKey && (!config || new URL(config.url).origin !== new URL(next.url).origin)) {
          throw new Error('切换到远程 Gateway 时必须明确输入 Key，不能沿用本地默认 Key。');
        }
        await saveConfig(file, next);
        config = next;
        clearTimeout(discoveryTimer);
        return status(res, 200, { config: visibleConfig(next) });
      }
      if (req.method === 'POST' && pathname === '/api/jobs') {
        if (!config) return fail(res, 409, '请先配置 Gateway。');
        const body = await readBody(req);
        const models = await listModels(config, options.fetcher || fetch);
        return status(res, 202, await jobs.start(body, config, models));
      }
      const match = /^\/api\/jobs\/([0-9a-f-]{36})(\/cancel)?$/.exec(pathname);
      if (match && req.method === 'GET' && !match[2]) return status(res, 200, jobs.get(match[1]));
      if (match && req.method === 'POST' && match[2]) return status(res, 200, jobs.cancel(match[1]));
      return fail(res, 404, '接口不存在。');
    } catch (e) {
      const reason = String(e?.message || e);
      const safe = config?.key ? reason.replaceAll(config.key, '[REDACTED]') : reason;
      return fail(res, 400, safe.slice(0, 450));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  if (!config) {
    discoveryTimer = setTimeout(tryDiscovery, 0);
    discoveryTimer.unref?.();
  }
  return {
    origin,
    issueURL() {
      clean();
      if (tickets.size > 100) tickets.clear();
      const ticket = rand();
      tickets.set(ticket, Date.now() + TICKET_TTL);
      return origin + '/open/' + ticket;
    },
    close() {
      closed = true;
      clearTimeout(discoveryTimer);
      server.close();
    },
  };
}
