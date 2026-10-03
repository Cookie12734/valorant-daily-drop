import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchShopSnapshot } from './riot-client.mjs';
import { LoginError } from './riot-login.mjs';

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

export function requestPath(rawUrl) {
  const path = decodeURIComponent(rawUrl.split(/[?#]/)[0]);
  if (!path.startsWith('/') || path.startsWith('//') || /[\\\x00-\x1f\x7f]/.test(path) || path.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid path');
  return path;
}

export function validHost(host, port) { return host === `127.0.0.1:${port}` || host === `localhost:${port}` || (port === 80 && ['127.0.0.1', 'localhost'].includes(host)); }

export function validShopRequest(request, port) {
  const headers = request.headers;
  return request.method === 'POST' && validHost(headers.host, port) && headers.origin === `http://${headers.host}` && (!headers['sec-fetch-site'] || headers['sec-fetch-site'] === 'same-origin') && headers['content-type']?.split(';')[0].trim() === 'application/json';
}

async function staticFiles(directory, prefix = '') {
  const files = new Map();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    const url = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) for (const pair of await staticFiles(path, url)) files.set(...pair);
    else if (entry.isFile() && TYPES[extname(entry.name)]) files.set(url, path);
  }
  return files;
}

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

async function emptyJsonBody(request) {
  let body = '';
  for await (const chunk of request) { body += chunk; if (body.length > 1024) throw new Error('Body too large'); }
  const value = JSON.parse(body);
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length) throw new Error('Invalid body');
}

export async function createLocalServer({ directory = fileURLToPath(new URL('../dist/', import.meta.url)), loadShop = fetchShopSnapshot, auth } = {}) {
  // Exact startup file inventory excludes scripts, exports, dotfiles and symlinks.
  const files = await staticFiles(directory);
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' https://media.valorant-api.com; connect-src 'self' https://valorant-api.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const port = server.address()?.port;
    if (!validHost(request.headers.host, port)) { json(response, 403, { error: 'このページはローカル接続専用です。' }); return; }
    let path;
    try { path = requestPath(request.url ?? ''); } catch { json(response, 400, { error: 'リクエストを読み取れません。' }); return; }
    if (path === '/api/status' && request.method === 'GET') { json(response, 200, { local: true, ...(auth ? { login: true, auth: auth.status() } : {}) }); return; }
    if (['/api/shop', '/api/login', '/api/logout'].includes(path)) {
      if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); json(response, 405, { error: 'POST が必要です。' }); return; }
      if (!validShopRequest(request, port)) { json(response, 403, { error: 'このページから接続し直してください。' }); return; }
      try { await emptyJsonBody(request); } catch { json(response, 400, { error: '空の JSON オブジェクトが必要です。' }); return; }
      if (path !== '/api/shop') {
        if (!auth) { json(response, 503, { error: 'npm startでログイン補助アプリを起動してください。' }); return; }
        try {
          if (path === '/api/login') auth.start(); else auth.logout();
          json(response, path === '/api/login' ? 202 : 200, { local: true, login: true, auth: auth.status() });
        } catch (error) { json(response, 429, { error: error instanceof LoginError ? error.message : '操作できませんでした。' }); }
        return;
      }
      if (auth && auth.status().state !== 'signed_in') { json(response, 401, { error: 'Riotアカウントでログインしてください。' }); return; }
      try { json(response, 200, await (auth ? auth.shop() : loadShop())); }
      catch (error) { json(response, 503, { error: auth ? error instanceof LoginError ? error.message : 'ショップを取得できません。時間をおいてもう一度お試しください。' : 'ショップを取得できません。Riot Client と VALORANT を起動してログインし、もう一度お試しください。' }); }
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') { json(response, 405, { error: 'この操作は利用できません。' }); return; }
    const file = files.get(path === '/' ? '/index.html' : path);
    if (!file) { json(response, 404, { error: 'ページが見つかりません。' }); return; }
    try {
      const content = await readFile(file);
      response.writeHead(200, { 'Content-Type': TYPES[extname(file)], 'Content-Length': content.length, 'Cache-Control': 'no-cache' });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch { json(response, 404, { error: 'ページが見つかりません。' }); }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('PORT には 1〜65535 を指定してください。'); process.exitCode = 1; }
  else {
    try {
      const server = await createLocalServer();
      server.on('error', () => { console.error('ローカルサーバーを起動できません。別の PORT を指定してください。'); process.exitCode = 1; });
      server.listen(port, '127.0.0.1', () => console.log(`VALO STORE: http://127.0.0.1:${port}`));
    } catch { console.error('サイトを読み取れません。dist のファイルを確認してください。'); process.exitCode = 1; }
  }
}
