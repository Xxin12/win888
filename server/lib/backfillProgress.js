'use strict';
/**
 * 回补进度内存存储 —— 供前端轮询显示实时进度条
 *
 * 维度: 按 code(股票)。同一 code 同一时刻仅一个回补任务在跑(由 backfillQueue 串行保证),
 *       故用 code 作键即可, 不必引入额外 jobId。
 *
 * 生命周期:
 *  - start():   任务开始, 写入 running 状态(含 totalPages 等初始元数据)。
 *  - update():  任务进行中, provider 每抓一页上报一次(合并 patch, 仅 running 态接受)。
 *  - finish():  任务终态(done/degraded/error), 写入最终结果并打上 expireAt(默认保留 5 分钟,
 *              便于前端轮询到最终结果后再淡出)。
 *  - get/isActive: 前端/路由读取与并发判断。
 */
const store = new Map();
const TTL_MS = 5 * 60 * 1000; // 终态保留时长, 超时自动清理

function now() { return Date.now(); }

/** 任务开始 */
function start(code, meta = {}) {
  store.set(code, {
    status: 'running',
    stage: '准备中',
    currentPage: 0,
    totalPages: meta.totalPages || 1,
    dates: 0,
    points: 0,
    daysWritten: 0,
    reqDays: meta.reqDays,
    source: meta.source,
    mode: meta.mode,
    rangeStart: meta.rangeStart,
    rangeEnd: meta.rangeEnd,
    startedAt: now(),
    updatedAt: now(),
    expireAt: 0, // 进行中不清理
  });
  return store.get(code);
}

/** 进度更新(仅 running 态接受, 防止终态被残留回调覆盖) */
function update(code, patch = {}) {
  const s = store.get(code);
  if (!s || s.status !== 'running') return s || null;
  Object.assign(s, patch, { updatedAt: now() });
  return s;
}

/** 任务终态: done / degraded / error */
function finish(code, result = {}) {
  let s = store.get(code);
  if (!s) {
    s = { status: 'done', startedAt: now(), updatedAt: now(), expireAt: now() + TTL_MS };
    store.set(code, s);
  }
  s.status = result.degraded ? 'degraded' : result.error ? 'error' : 'done';
  s.stage = s.status === 'done' ? '完成' : (s.status === 'degraded' ? '降级' : '错误');
  s.updatedAt = now();
  s.expireAt = now() + TTL_MS;
  Object.assign(s, {
    ok: result.ok,
    written: result.written,
    points: result.points != null ? result.points : s.points,
    dates: result.dates,
    capped: result.capped,
    rangeCapped: result.rangeCapped,
    skippedExisting: result.skippedExisting,
    upToDate: result.upToDate,
    reason: result.reason,
    error: result.error,
  });
  if (result.stage) s.stage = result.stage;
  return s;
}

/** 读取当前快照(终态超时被清理则返回 null) */
function get(code) {
  const s = store.get(code);
  if (!s) return null;
  if (s.expireAt && now() > s.expireAt) { store.delete(code); return null; }
  return s;
}

/** 是否正在回补(进行中) */
function isActive(code) {
  const s = store.get(code);
  if (!s) return false;
  if (s.expireAt && now() > s.expireAt) { store.delete(code); return false; }
  return s.status === 'running';
}

function list() { return Array.from(store.values()); }

module.exports = { start, update, finish, get, isActive, list, TTL_MS };
