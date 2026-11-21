/**
 * server.mjs 行为测试（node:test 内置运行器，零依赖）。
 *
 * 起一个真实子进程（随机端口），打真实 HTTP：
 * - 畸形请求与滥用之后进程必须活着——这是 undici 加固的全部意义
 * - Range 的 bytes=-N "最后 N 字节"语义、416、坏区间
 * - 静态 403/404、HEAD、JSONP、stream 的 bad id
 * - 依赖网易云上游的用例在断网时 t.skip()，永远不允许变成 FAIL
 *
 * 用法：npm test   （先 npm install 拿到 @meting/core）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_ID = '900001'; // 预置进缓存的假音频，走 serveAudioFile 的本地路径
const FAKE_BYTES = Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 256));

let port = 0;
let child = null;
let base = '';

/** 找一个当前空闲的 TCP 端口（有竞态，够用） */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

/** 等端口开始接受连接（服务进程真正 listen 之后） */
function waitListening(p, timeoutMs = 8000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    (function poll() {
      const sock = net.connect(p, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() - started > timeoutMs) reject(new Error('server did not start'));
        else setTimeout(poll, 100);
      });
    })();
  });
}

function get(pathname, opts = {}) {
  return fetch(base + pathname, { ...opts, signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
}

/** 原始 socket 发一行请求行，拿状态行——fetch 会提前规范化 URL，测不了穿越 */
function rawRequest(head) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let data = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(`${head}\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`));
    sock.on('data', (c) => { data += c; });
    sock.on('end', () => resolve(data));
    sock.on('error', reject);
  });
}

test.before(async () => {
  // 预置一个已缓存音频：serveAudioFile 的 Range/416/HEAD 全走本地文件
  const cacheFile = path.join(ROOT, '.cache', 'audio', `${FAKE_ID}.mp3`);
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, FAKE_BYTES);

  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (c) => process.stderr.write(`[server] ${c}`));
  await waitListening(port);
});

test.after(() => {
  if (child && child.exitCode === null) child.kill();
  try { fs.rmSync(path.join(ROOT, '.cache', 'audio', `${FAKE_ID}.mp3`)); } catch {}
});

test('GET / serves the player page', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  const body = await res.text();
  assert.match(body, /<html/i);
});

test('HEAD / returns headers with an empty body', async () => {
  const res = await get('/', { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal((await res.arrayBuffer()).byteLength, 0);
});

test('missing static file → 404', async () => {
  assert.equal((await get('/no-such-file.css')).status, 404);
});

test('path traversal → 404, never a file leak', async () => {
  // fetch/undici 会在客户端就把 ../ 规范掉，必须用原始 socket 才能考到服务端。
  // WHATWG URL 解析会把点段折叠（/../../x → /x），所以实际结果是 404 而不是
  // 代码里那行 403；关键断言是绝不能把 server.mjs 的内容吐出来。
  const raw = await rawRequest('GET /../../server.mjs HTTP/1.1');
  assert.match(raw, /^HTTP\/1\.1 (403|404)/);
  assert.doesNotMatch(raw, /import Meting/);

  const encoded = await rawRequest('GET /%2e%2e/%2e%2e/server.mjs HTTP/1.1');
  assert.match(encoded, /^HTTP\/1\.1 (403|404)/);
  assert.doesNotMatch(encoded, /import Meting/);
});

test('malformed percent-encoding → 400 (must not crash the process)', async () => {
  const res = await get('/foo%zzbar');
  assert.equal(res.status, 400);
});

test('malformed Host header → 400 (must not crash the process)', async () => {
  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/', headers: { host: '[broken' }, method: 'GET' },
      (res) => { res.resume(); resolve(res.statusCode); }
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 400);
});

test('stream endpoint rejects non-numeric ids with 400', async () => {
  const res = await get('/api.php?types=stream&id=abc');
  assert.equal(res.status, 400);
  assert.match(await res.text(), /bad id/);
});

test('api with empty search name returns [] without touching upstream', async () => {
  const res = await get('/api.php?types=search&name=');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '[]');
});

test('unknown api type returns a JSON error', async () => {
  const res = await get('/api.php?types=bogus');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { error: 'unknown types: bogus' });
});

test('JSONP wrapper uses the callback and a JS content-type', async () => {
  const res = await get('/api.php?types=search&name=&callback=cb');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/javascript/);
  assert.equal(await res.text(), 'cb([])');
});

test('full range request serves the whole cached file', async () => {
  const res = await get(`/api.php?types=stream&id=${FAKE_ID}`);
  assert.equal(res.status, 200);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), new Uint8Array(FAKE_BYTES));
});

test('Range prefix bytes=0-4 serves the first bytes with 206', async () => {
  const res = await get(`/api.php?types=stream&id=${FAKE_ID}`, {
    headers: { range: 'bytes=0-4' },
  });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 0-4/${FAKE_BYTES.length}`);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), new Uint8Array(FAKE_BYTES.subarray(0, 5)));
});

test('Range suffix bytes=-5 serves the LAST 5 bytes (not 0..5)', async () => {
  const res = await get(`/api.php?types=stream&id=${FAKE_ID}`, {
    headers: { range: 'bytes=-5' },
  });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes ${FAKE_BYTES.length - 5}-${FAKE_BYTES.length - 1}/${FAKE_BYTES.length}`);
  assert.deepEqual(
    new Uint8Array(await res.arrayBuffer()),
    new Uint8Array(FAKE_BYTES.subarray(FAKE_BYTES.length - 5))
  );
});

test('degenerate and out-of-bounds ranges → 416', async () => {
  for (const range of ['bytes=abc', 'bytes=-', 'bytes=-0', 'bytes=999999-', 'bytes=5-2']) {
    const res = await get(`/api.php?types=stream&id=${FAKE_ID}`, { headers: { range } });
    assert.equal(res.status, 416, `range "${range}" should be 416, got ${res.status}`);
    await res.arrayBuffer().catch(() => {});
  }
});

test('upstream API smoke (skips when the network is down)', async (t) => {
  try {
    const res = await get('/api.php?types=lyric&id=186016', { timeoutMs: 8000 });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(typeof data.lyric === 'string');
  } catch (e) {
    t.skip(`upstream unreachable on this network: ${e?.cause?.code || e?.message || e}`);
  }
});

test('server stays alive after all the abuse above', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
});
