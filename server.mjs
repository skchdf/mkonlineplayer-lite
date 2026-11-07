#!/usr/bin/env node
/**
 * MKOnlinePlayer 自托管服务
 * - 静态托管 public/ 里的播放器前端
 * - /api.php 复刻旧版 Meting 的 types 协议，后端用 @meting/core（仅网易云）
 * 用法: node server.mjs   (PORT=8099 HOST=127.0.0.1)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Meting from '@meting/core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = Number(process.env.PORT || 8099);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};

// ---- 极简 TTL 缓存 ----
const cache = new Map();
const TTL = { url: 10 * 60e3 };
const DEFAULT_TTL = 60 * 60e3;
function getCache(k) {
  const v = cache.get(k);
  if (!v) return undefined;
  if (Date.now() > v.exp) { cache.delete(k); return undefined; }
  return v.data;
}
function setCache(k, data, ttl) {
  if (cache.size > 800) cache.clear();
  cache.set(k, { data, exp: Date.now() + ttl });
}

/** 调用 Meting，返回已 JSON.parse 的数据 */
async function call(type, ...args) {
  // 注意：搜索的 args 里带 { page, limit } 对象，不能用 args.join(',')，
  // 否则不同页码会得到同一个 "[object Object]" 缓存键，永远返回第一页。
  const key = `${type}/${JSON.stringify(args)}`;
  const hit = getCache(key);
  if (hit !== undefined) return hit;
  const meting = new Meting('netease');
  meting.format(true);
  const raw = await meting[type](...args);
  let data;
  try { data = JSON.parse(raw); } catch { data = null; }
  if (data !== null) setCache(key, data, TTL[type] ?? DEFAULT_TTL);
  return data;
}

/** 给上游请求加超时，避免前端一直转圈 */
function withTimeout(promise, ms = 25000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('upstream timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function fixUrl(u) {
  if (!u) return '';
  return u
    .replace('://m7c.', '://m7.')
    .replace('://m8c.', '://m8.')
    .replace('http://', 'https://');
}

/** 兼容旧 api.php 的 types 协议（source 参数保留兼容，但只使用网易云） */
async function handleApi(q) {
  const type = q.get('types') || 'search';

  switch (type) {
    case 'search': {
      const name = q.get('name') || '';
      const count = Math.min(Number(q.get('count') || 20) || 20, 50);
      const page = Math.max(Number(q.get('pages') || 1) || 1, 1);
      if (!name) return [];
      const data = await call('search', name, { page, limit: count });
      return data || [];
    }
    case 'url': {
      const data = await call('url', q.get('id'), 320);
      const url = fixUrl(data?.url || '');
      return { url, size: data?.size || 0, br: data?.br || -1 };
    }
    case 'pic': {
      const data = await call('pic', q.get('id'));
      return { url: fixUrl(data?.url || '') };
    }
    case 'lyric': {
      const data = await call('lyric', q.get('id'));
      return { lyric: data?.lyric || '', tlyric: data?.tlyric || '' };
    }
    default:
      return { error: `unknown types: ${type}` };
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

/** 读取 POST body（前端 mkPlayer.method = POST，jQuery 同源 jsonp 会走 XHR POST） */
function readBody(req, limit = 1 << 20) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); resolve(''); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api.php' || url.pathname === '/api') {
    const t0 = Date.now();
    const params = new URLSearchParams(url.searchParams);
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (body) new URLSearchParams(body).forEach((v, k) => params.set(k, v));
    }
    const cb = params.get('callback');
    let payload;
    try {
      payload = JSON.stringify(await withTimeout(handleApi(params)));
    } catch (e) {
      // 上游超时/失败时返回空结构，避免前端卡在“加载中”
      const t = params.get('types');
      const empty = {
        search: '[]',
        lyric: JSON.stringify({ lyric: '', tlyric: '' }),
        url: JSON.stringify({ url: '', size: 0, br: -1 }),
        pic: JSON.stringify({ url: '' }),
      }[t] || '{}';
      payload = empty;
      console.error('[api]', params.toString(), '->', e?.message || e);
    }
    console.log('[api]', params.toString(), `-> 200 ${Date.now() - t0}ms`);
    if (cb && /^[\w.$]+$/.test(cb)) {
      return send(res, 200, `${cb}(${payload})`, { 'content-type': 'text/javascript; charset=utf-8' });
    }
    return send(res, 200, payload, { 'content-type': 'application/json; charset=utf-8' });
  }

  // 静态文件
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT)) return send(res, 403, 'forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'not found');
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size,
    });
    fs.createReadStream(file).pipe(res);
  });
});

const listenOptions = HOST === '::'
  ? { port: PORT, host: HOST, ipv6Only: false } // 显式双栈：公网 IPv6 + 局域网 IPv4
  : { port: PORT, host: HOST };

server.listen(listenOptions, () => {
  const displayHost = HOST.includes(':') ? `[${HOST}]` : HOST;
  console.log(`MKOnlinePlayer 已启动: http://${displayHost}:${PORT}`);
});
