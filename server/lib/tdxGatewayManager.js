'use strict';
/**
 * TDX 网关生命周期管理器 (由 Web 启停 pytdx 网关子进程)
 * ---------------------------------------------------------
 * - 把 server/gateway/tdx_gateway.py 作为子进程拉起 / 停止
 * - 配置读写 server/gateway/gateway.config.json
 * - 启动后轮询 /healthz, 连通即把端点/Token 回写 process.env, 使运行时 provider 生效
 * - 捕获子进程 stdout/stderr 进环形缓冲, 供前端实时展示
 * - checkDeps 仅检测 python/pytdx, 不自动安装
 *
 * 安全: 本模块仅适合本机开发环境; 网关由 Web 触发拉起(同机子进程), 切勿公网暴露本服务。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const GATEWAY_DIR = path.join(__dirname, '..', 'gateway');
const CONFIG_PATH = path.join(GATEWAY_DIR, 'gateway.config.json');
const SCRIPT = path.join(GATEWAY_DIR, 'tdx_gateway.py');

const DEFAULTS = {
  TDX_TOKEN: '',
  PORT: 8899,
  BIND: '0.0.0.0',
  TDX_HOSTS: '',          // 可选, 逗号分隔 "ip:port,..."
  TDX_REQUEST_GAP_MS: 400,
  TDX_MAX_RETRY: 3,
  TDX_CACHE_MAX: 4000,
  PYTHON_BIN: '',         // 留空自动探测 (python/python3/py)
};

let child = null;
let startedAt = 0;
let logLines = [];
const LOG_MAX = 200;
let health = { connected: false, host: null, pytdx: null };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function pushLog(line) {
  line = String(line).replace(/\n+$/, '');
  if (!line) return;
  logLines.push('[' + new Date().toLocaleTimeString('zh-CN') + '] ' + line);
  if (logLines.length > LOG_MAX) logLines = logLines.slice(-LOG_MAX);
}

// ---------------------------------------------------------------- 配置
function loadConfig() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (_) {}
  return Object.assign({}, DEFAULTS, saved);
}
function saveConfig(cfg) {
  const merged = Object.assign({}, DEFAULTS, cfg || {});
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2)); } catch (e) {
    throw new Error('写入配置失败: ' + e.message);
  }
  return merged;
}

// ---------------------------------------------------------------- 子进程拉起 (python 候选回退)
function spawnWithFallback(candidates, args, opts) {
  return new Promise((resolve, reject) => {
    let i = 0;
    const tryNext = () => {
      if (i >= candidates.length) return reject(new Error('未找到可用的 Python 解释器(已尝试: ' + candidates.join(', ') + ')'));
      const bin = candidates[i++];
      let c;
      const onErr = (err) => {
        if (c) c.removeListener('error', onErr);
        if (i < candidates.length) tryNext();
        else reject(err);
      };
      try {
        c = spawn(bin, args, opts);
      } catch (e) { return reject(e); }
      c.on('error', onErr);
      // 若 600ms 内无 ENOENT 类错误, 认为已成功拉起
      setTimeout(() => { if (c) c.removeListener('error', onErr); resolve(c); }, 600);
    };
    tryNext();
  });
}

// ---------------------------------------------------------------- 健康探测
function probeOnce(port) {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:' + port + '/healthz', (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(2000, () => { req.destroy(); resolve(null); });
  });
}

// 后台持续刷新 health(覆盖本进程 spawn 与外部手动设置两种情形)
function bgTick() {
  const ep = (process.env.TDX_ENDPOINT || '').replace(/\/+$/, '');
  if (!ep) { health = { connected: false, host: null, pytdx: null }; return; }
  const req = http.get(ep + '/healthz', (res) => {
    let b = '';
    res.on('data', (d) => (b += d));
    res.on('end', () => {
      try {
        const j = JSON.parse(b);
        health = { connected: !!j.connected, host: j.host || null, pytdx: j.pytdx };
      } catch (_) { health = { connected: false, host: null, pytdx: null }; }
    });
  });
  req.on('error', () => { health = { connected: false, host: null, pytdx: null }; });
  req.setTimeout(3000, () => req.destroy());
}
setInterval(bgTick, 5000);

// ---------------------------------------------------------------- 启停
async function start() {
  if (child && !child.killed) return { ok: false, reason: '网关已在运行', pid: child.pid };
  if (!fs.existsSync(SCRIPT)) return { ok: false, reason: '未找到网关脚本: ' + SCRIPT };
  const cfg = loadConfig();
  const env = Object.assign({}, process.env);
  if (cfg.TDX_TOKEN) env.TDX_TOKEN = cfg.TDX_TOKEN;
  if (cfg.BIND) env.BIND = cfg.BIND;
  env.PORT = String(cfg.PORT);
  if (cfg.TDX_HOSTS) env.TDX_HOSTS = cfg.TDX_HOSTS;
  env.TDX_REQUEST_GAP_MS = String(cfg.TDX_REQUEST_GAP_MS);
  env.TDX_MAX_RETRY = String(cfg.TDX_MAX_RETRY);
  env.TDX_CACHE_MAX = String(cfg.TDX_CACHE_MAX);

  const candidates = cfg.PYTHON_BIN ? [cfg.PYTHON_BIN] : ['python', 'python3', 'py'];
  pushLog('[mgr] 启动网关: ' + candidates.join(' / ') + ' ' + SCRIPT);
  let c;
  try {
    c = await spawnWithFallback(candidates, [SCRIPT], { cwd: GATEWAY_DIR, env });
  } catch (e) {
    pushLog('[mgr] 启动失败: ' + e.message);
    return { ok: false, reason: e.message };
  }
  child = c;
  startedAt = Date.now();
  c.stdout.on('data', (b) => b.toString().split('\n').forEach((l) => pushLog(l)));
  c.stderr.on('data', (b) => b.toString().split('\n').forEach((l) => pushLog('[err] ' + l)));
  c.on('exit', (code, sig) => {
    const wasRunning = child === c;
    child = null;
    health = { connected: false, host: null, pytdx: null };
    if (wasRunning) pushLog('[mgr] 网关退出 code=' + code + ' signal=' + sig);
  });
  pushLog('[mgr] 子进程已拉起 pid=' + c.pid + ', 等待 /healthz ...');

  // 等待连通(最多 ~25s), 连通后回写本 server 的 TDX_ENDPOINT/TDX_TOKEN
  // 冷启动容差: Windows Defender 首次扫描新拉起的 python 进程(含 pytdx/numpy 等 .pyd)
  // 常需 40~60s, 原 25s 窗口会在网关就绪前超时, 导致 TDX_ENDPOINT 永不被设置、回补静默失效。
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (!child) return { ok: false, reason: '网关启动后意外退出' };
    const h = await probeOnce(cfg.PORT);
    // 只要网关 HTTP 服务可达(ok=true)即视为已启动并写端点。
    // 注意: 网关对 TDX 是懒连接, healthz 的 connected 在首次 /kline 前恒为 false,
    // 不能用它作为"启动成功"判据, 否则 TDX_ENDPOINT 永不被设置。
    if (h && h.ok) {
      process.env.TDX_ENDPOINT = 'http://127.0.0.1:' + cfg.PORT;
      if (cfg.TDX_TOKEN) process.env.TDX_TOKEN = cfg.TDX_TOKEN;
      pushLog('[mgr] 网关已连通(HTTP), 已设置本 server TDX_ENDPOINT=' + process.env.TDX_ENDPOINT);
      return { ok: true, pid: c.pid, endpoint: process.env.TDX_ENDPOINT };
    }
    await sleep(1000);
  }
  pushLog('[mgr] 超时未连通(可能 pytdx 未装/网络受限), 但进程已启动, 可查看日志排查');
  return { ok: true, pid: c.pid, endpoint: null, warn: '未检测到 /healthz 连通' };
}

function stop() {
  if (!child) return { ok: true, stopped: false, reason: '网关未在运行' };
  const pid = child.pid;
  try { child.kill('SIGTERM'); } catch (_) {}
  child = null;
  health = { connected: false, host: null, pytdx: null };
  // 停止后清除本 server 的端点/Token: 否则 available() 仍为真而网关已死,
  // 会导致回补时静默返回"回补0天"而非明确的"网关未启动"提示。
  delete process.env.TDX_ENDPOINT;
  delete process.env.TDX_TOKEN;
  pushLog('[mgr] 已发送 SIGTERM, pid=' + pid + '，已清除本 server TDX_ENDPOINT/TDX_TOKEN');
  return { ok: true, stopped: true, pid };
}

function status() {
  return {
    running: !!(child && !child.killed),
    pid: child ? child.pid : null,
    endpoint: (process.env.TDX_ENDPOINT || '').replace(/\/+$/, '') || null,
    health,
    uptimeSec: child ? Math.round((Date.now() - startedAt) / 1000) : 0,
    logs: logLines.slice(-60),
  };
}

// ---------------------------------------------------------------- 依赖检测 (仅检测, 不安装)
async function checkDeps() {
  const cfg = loadConfig();
  const candidates = cfg.PYTHON_BIN ? [cfg.PYTHON_BIN] : ['python', 'python3', 'py'];
  const probe = (bin) => new Promise((resolve) => {
    // 网关脚本在模块顶层 import fastapi/uvicorn/pytdx, 三者缺一即崩溃
    const p = spawn(bin, ['-c', 'import pytdx, fastapi, uvicorn; print("deps_ok")'], { env: process.env });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', () => resolve({ python: false, pytdx: false, fastapi: false, uvicorn: false }));
    p.on('exit', (code) => resolve({
      python: code !== null && code !== 127,
      depsOk: /deps_ok/.test(out),
    }));
  });
  for (const bin of candidates) {
    const r = await probe(bin);
    if (r.python) {
      // depsOk 仅在 pytdx+fastapi+uvicorn 全部可 import 时为 true
      return { python: bin, pytdx: r.depsOk, fastapi: r.depsOk, uvicorn: r.depsOk, allOk: r.depsOk };
    }
  }
  return { python: null, pytdx: false, fastapi: false, uvicorn: false, allOk: false };
}

module.exports = {
  loadConfig, saveConfig, start, stop, status, checkDeps,
  DEFAULTS,
};
