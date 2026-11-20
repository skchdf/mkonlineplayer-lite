#!/usr/bin/env node
/**
 * MKOnlinePlayer 自托管服务
 * - 静态托管 public/ 里的播放器前端
 * - /api.php 复刻旧版 Meting 的 types 协议，后端用 @meting/core（仅网易云）
 * 用法: node server.mjs   (PORT=8888 HOST=127.0.0.1)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import Meting from '@meting/core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = Number(process.env.PORT || 8888);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
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

// ---- 音频中转与本地缓存 ----
// 局域网的手机等设备不再直连网易云 CDN：统一由本机下载后经局域网转发，
// 并把整首下到本地，第二次播放起完全不碰外网。CDN 抽风时最多卡第一次。
const AUDIO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '.cache', 'audio');
const CACHE_LIMIT = 1.5 * 1024 ** 3;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

fs.mkdirSync(AUDIO_DIR, { recursive: true });

let cacheBytes = 0;
for (const f of fs.readdirSync(AUDIO_DIR)) {
  if (f.endsWith('.part')) { try { fs.unlinkSync(path.join(AUDIO_DIR, f)); } catch {} continue; }
  try { cacheBytes += fs.statSync(path.join(AUDIO_DIR, f)).size; } catch {}
}

const audioPath = (id) => path.join(AUDIO_DIR, `${id}.mp3`);
const prefetching = new Map();

function pruneCache() {
  if (cacheBytes <= CACHE_LIMIT) return;
  const files = fs.readdirSync(AUDIO_DIR)
    .map((f) => { try { const st = fs.statSync(path.join(AUDIO_DIR, f)); return { f, size: st.size, t: st.atimeMs || st.mtimeMs }; } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => a.t - b.t);
  for (const { f, size } of files) {
    if (cacheBytes <= CACHE_LIMIT * 0.9) break;
    try { fs.unlinkSync(path.join(AUDIO_DIR, f)); cacheBytes -= size; } catch {}
  }
}

async function resolveAudioUrl(id) {
  const data = await call('url', id, 320);
  const u = fixUrl(data?.url || '');
  // 拿不到直链时退回老接口，它 302 到 CDN
  return u || `https://music.163.com/song/media/outer/url?id=${id}.mp3`;
}

/** 后台把整首下到本地缓存；同一首并发只下载一次 */
function prefetch(id) {
  const file = audioPath(id);
  try { if (fs.statSync(file).isFile()) return Promise.resolve(file); } catch {}
  let job = prefetching.get(id);
  if (job) return job;
  const part = file + '.part';
  job = (async () => {
    const t0 = Date.now();
    const url = await resolveAudioUrl(id);
    const resp = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(180000),
    });
    const ct = resp.headers.get('content-type') || '';
    if (!resp.ok) throw new Error(`upstream ${resp.status}`);
    if (!/^(audio\/|application\/octet-stream)/.test(ct)) throw new Error(`非音频响应: ${ct}`);
    await pipeline(Readable.fromWeb(resp.body), fs.createWriteStream(part));
    const st = fs.statSync(part);
    if (st.size < 8192) throw new Error(`文件过小: ${st.size}`);
    fs.renameSync(part, file);
    cacheBytes += st.size;
    pruneCache();
    const ms = Date.now() - t0;
    if (ms > 3000) console.log('[audio] 缓存较慢', id, `${(st.size / 1048576).toFixed(1)}MB`, `${ms}ms`);
    return file;
  })().catch((e) => {
    try { fs.unlinkSync(part); } catch {}
    console.error('[audio] 缓存失败', id, e.message);
    throw e;
  }).finally(() => prefetching.delete(id));
  prefetching.set(id, job);
  return job;
}

function audioHeaders(res, extra) {
  res.writeHead(extra.status, {
    'content-type': 'audio/mpeg',
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=604800',
    ...extra.headers,
  });
}

/** 组装 Content-Disposition（附件下载；中文等非 ASCII 用 RFC 5987 filename*） */
function contentDisposition(name) {
  const safe = String(name || '').replace(/[\\/:*?"<>|\r\n]/g, '_').replace(/\s+/g, ' ').trim() || `song-${Date.now()}`;
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

/** 从本地文件提供音频，支持 Range（拖动进度条） */
async function serveAudioFile(req, res, file, extraHeaders = {}) {
  const st = await fs.promises.stat(file);
  const range = req.headers.range;
  if (!range) {
    audioHeaders(res, { status: 200, headers: { 'content-length': st.size, ...extraHeaders } });
    if (req.method === 'HEAD') return res.end();
    return pipeline(fs.createReadStream(file), res).catch(() => {});
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
  // bytes=-N 语义是"最后 N 个字节"，不是 0..N
  let start, end;
  if (!m || (m[1] === '' && m[2] === '')) {
    res.writeHead(416, { 'content-type': 'audio/mpeg', 'content-range': `bytes */${st.size}` });
    return res.end();
  }
  if (m[1] === '') {
    const n = Number(m[2]);
    if (!Number.isFinite(n) || n <= 0) {
      res.writeHead(416, { 'content-type': 'audio/mpeg', 'content-range': `bytes */${st.size}` });
      return res.end();
    }
    start = Math.max(0, st.size - n);
    end = st.size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] !== '' ? Number(m[2]) : st.size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= st.size) {
      res.writeHead(416, { 'content-type': 'audio/mpeg', 'content-range': `bytes */${st.size}` });
      return res.end();
    }
    end = Math.min(end, st.size - 1);
  }
  audioHeaders(res, {
    status: 206,
    headers: {
      'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${st.size}`,
      ...extraHeaders,
    },
  });
  if (req.method === 'HEAD') return res.end();
  return pipeline(fs.createReadStream(file, { start, end }), res).catch(() => {});
}

/** 缓存没命中时实时转发上游（含 Range），同时后台继续落盘 */
async function proxyAudio(req, res, id, extraHeaders = {}) {
  const url = await resolveAudioUrl(id);
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const headers = { 'user-agent': UA };
  if (req.headers.range) headers.range = req.headers.range;
  const upstream = await fetch(url, { headers, redirect: 'follow', signal: ac.signal });
  const ct = upstream.headers.get('content-type') || '';
  if (!upstream.ok || !/^(audio\/|application\/octet-stream)/.test(ct)) {
    console.error('[audio] 上游异常', id, upstream.status, ct);
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('upstream error');
  }
  const out = {};
  for (const k of ['content-length', 'content-range']) {
    const v = upstream.headers.get(k);
    if (v) out[k] = v;
  }
  audioHeaders(res, { status: upstream.status, headers: { ...out, ...extraHeaders } });
  if (req.method === 'HEAD') { ac.abort(); return res.end(); }
  return pipeline(Readable.fromWeb(upstream.body), res).catch(() => {});
}

async function handleStream(req, res, id, extraHeaders = {}) {
  if (!/^\d+$/.test(String(id))) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('bad id');
  }
  const file = audioPath(id);
  try {
    if (fs.statSync(file).isFile()) return serveAudioFile(req, res, file, extraHeaders);
  } catch {}
  // 已缓存就直接用；否则给它几秒钟试着落盘，够快就本地发，慢就边转边下
  const job = prefetch(id);
  const ok = await Promise.race([
    job.then(() => true, () => false),
    new Promise((r) => setTimeout(() => r(false), 8000)),
  ]);
  if (ok && fs.existsSync(file)) return serveAudioFile(req, res, file, extraHeaders);
  return proxyAudio(req, res, id, extraHeaders);
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
      const id = q.get('id') || '';
      const data = await call('url', id, 320);
      const url = fixUrl(data?.url || '');
      return {
        url,
        // 播放走中转地址：局域网设备不直连 CDN，且第二次起命中本地缓存
        stream: url ? `/api.php?types=stream&id=${encodeURIComponent(id)}` : '',
        size: data?.size || 0,
        br: data?.br || -1,
      };
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
  // 客户端中途断开是常态（手机锁屏、切歌），不能让它变成未处理的 'error' 事件把进程带崩
  req.on('error', () => {});
  res.on('error', () => {});

  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    // Host 头或请求行非法：按 400 处理，而不是抛异常
    return send(res, 400, JSON.stringify({ error: 'bad request' }), { 'content-type': 'application/json; charset=utf-8' });
  }

  if (url.pathname === '/api.php' || url.pathname === '/api') {
    const t0 = Date.now();
    const params = new URLSearchParams(url.searchParams);
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (body) new URLSearchParams(body).forEach((v, k) => params.set(k, v));
    }
    const cb = params.get('callback');
    if (params.get('types') === 'stream') {
      // download=1 时作为附件下载；文件名由前端传 name 参数（含中文时用 RFC 5987 编码）
      const extra = {};
      if (params.get('download')) {
        extra['content-disposition'] = contentDisposition(params.get('name') || `song-${params.get('id')}`);
      }
      try {
        return await handleStream(req, res, params.get('id'), extra);
      } catch (e) {
        console.error('[audio]', params.get('id'), e?.message || e);
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('audio error');
      }
    }
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
  let p;
  try {
    p = decodeURIComponent(url.pathname);
  } catch {
    // /foo%zz 这类非法百分号编码：按 400 处理，而不是 URIError 崩掉进程
    return send(res, 400, 'bad request');
  }
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT)) return send(res, 403, 'forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'not found');
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size,
    });
    if (req.method === 'HEAD') return res.end();
    pipeline(fs.createReadStream(file), res).catch(() => {}); // 客户端断开/读盘失败只断流，不崩进程
  });
});

// 监听失败（端口被占用、权限不足等）给出明确提示再退出
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，请换一个：PORT=其他端口 node server.mjs`);
  } else {
    console.error('服务器错误:', e.message);
  }
  process.exit(1);
});

// 收请求本身加超时，防止僵尸连接占着 socket
server.headersTimeout = 30000;
server.requestTimeout = 60000;

// 兜底：任何漏网的异步错误只记日志，不让自托管进程直接退出
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.stack || e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e?.stack || e));

const listenOptions = HOST === '::'
  ? { port: PORT, host: HOST, ipv6Only: false } // 双栈
  : { port: PORT, host: HOST };

server.listen(listenOptions, () => {
  console.log(`MKOnlinePlayer 已启动，端口 ${PORT}`);
});
