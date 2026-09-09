'use strict';
/**
 * 批量回补: 遍历(全部或筛选的) A股, 按类型回补分时 / 5分钟 / 日线。
 *
 * 设计要点:
 *  - 三种类型各维护一个后台任务(intraday / 5min / day), 互不影响, 可并行发起。
 *  - 顺序遍历代码, 每次抓取前经本模块专属独立限流器 bulkAcquire() —— 与 dailySync 限流、单只回补 backfillRate 均隔离,
 *    速率由 BULK_BACKFILL_MIN_GAP_MS 控制(默认 150ms ≈ 6.7 请求/秒)。
 *  - 5分钟 / 日线: 默认「跳过本地已有」(local CSV 非空即不重抓, 重复跑很便宜、只补缺),
 *    force=true 时强制重新拉取全量(刷新已存在的数据)。
 *  - 分时: 「本地有即整只跳过」—— 只要本地已存在任意分时数据(不管多少/是否追平最新收盘日),
 *    直接跳过, 不发任何接口请求、不做对比; 仅本地完全没有分时的股票才进入回补队列排队拉取。
 *
 *    ★ 分时「本地有无」的判断做了两级加速(解决逐库打开过慢):
 *      1) 覆盖索引快路径(毫秒级): 一次性批量查 global.db 的 stock_coverage 表(intraday_dates),
 *         该表在每次落盘 recordCoverage 时同步更新、启动时已 seed 全市场 —— 权威且极快, 无需打开任何单只 .db。
 *      2) 多线程判断(worker_threads): 对"覆盖表中查不到行"的不确定代码子集(通常为空/极少, 如传入池外代码),
 *         拆分到多个 worker 并行打开 .db 判断, 避免主线程逐个 ~百毫秒地串行卡住。
 *      判定结果: 本地有分时 → 直接跳过(skip); 本地无分时 → 加入回补队列, 由主循环按全局限流顺序回补。
 *    (force=true 时忽略上述判断、全部强制重新拉取。)
 *  - 单只失败不中断整体, 计入 fail 并继续。
 */
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const intraday = require('./intradayRecorder');
const tencent = require('../providers/tencent');
const { isIndexCode } = require('./indices');
const { loadBars } = require('./klineService');
const universe = require('./stockUniverse');
const dataSource = require('./dataSource');
const ms = require('./marketStore'); // 时序数据(按股票隔离 SQLite)
const gstore = require('./globalStore'); // 全局库(含 stock_coverage 覆盖索引)
const { DB_DIR, setMeta, getMeta, globalDb } = require('./db');
const wecom = require('./wecom');

const CHECK_WORKER = path.join(__dirname, 'intradayCheckWorker.js');

// ---------------- 独立请求限流器(与 dailySync 限流、单只回补 backfillRate 均隔离) ----------------
// 速率由环境变量 BULK_BACKFILL_MIN_GAP_MS 控制(默认 150ms ≈ 6.7 请求/秒)。
const BULK_GAP_MS = Math.max(40, parseInt(process.env.BULK_BACKFILL_MIN_GAP_MS || '150', 10));
let _bchain = Promise.resolve();
let _blast = 0;
function bulkAcquire() {
  const p = _bchain.then(async () => {
    const wait = BULK_GAP_MS - (Date.now() - _blast);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    _blast = Date.now();
  });
  _bchain = p.catch(() => {});
  return p;
}

// ---------------- 执行日志 + 结果汇总(供前端"执行日志"/"结果汇总"展示) ----------------
// 三类回补分时/5分钟/日线可独立并发, 日志按时间混排(带时间戳), 汇总按类型分桶持久化。
let _logs = [];
let _lastResults = {}; // { [type]: summary }
const MAX_LOGS = 600;
const TYPE_TEXT = { intraday: '分时行情', '5min': '5分钟行情', day: '日线行情' };
function pushLog(line) {
  const t = new Date().toTimeString().slice(0, 8);
  _logs.push(`[${t}] ${line}`);
  if (_logs.length > MAX_LOGS) _logs = _logs.slice(-MAX_LOGS);
  try { setMeta('bulk_backfill_log', JSON.stringify(_logs)); } catch (_) { /* ignore */ }
}
// 模块加载时恢复上一次运行的执行日志与结果汇总(刷新页面后仍能查看)
try { const raw = getMeta('bulk_backfill_log'); if (raw) _logs = JSON.parse(raw); } catch (_) { /* ignore */ }
try { const raw = getMeta('bulk_backfill_status'); if (raw) _lastResults = JSON.parse(raw); } catch (_) { /* ignore */ }

// ---------------- 企微通知 ----------------
function srcLabel(s) { return s === 'tdx' ? '通达信' : s === 'eastmoney' ? '东财' : (s || '默认源'); }
function buildBulkNotifyText(type, s) {
  const label = TYPE_TEXT[type] || type;
  const dur = s.durationMs != null ? `${Math.round(s.durationMs / 1000)}秒` : '-';
  const depth = (s.start && s.end) ? `日期区间 ${s.start}~${s.end}` : (s.days ? `最近 ${s.days} 交易日` : (type === 'intraday' ? '全量历史' : '—'));
  const lines = [];
  lines.push(`<@huangxuanxin>`);
  lines.push(`📥 **批量回补完成 · ${label}**`);
  lines.push(`> 数据源：${srcLabel(s.source)}`);
  if (type === 'intraday') lines.push(`> 回补深度：${depth}`);
  lines.push(`> 处理股票：**${s.total}** 只${s.force ? '（含本地已有·强制刷新）' : '（仅补缺）'}`);
  lines.push(`> 成功写入：**${s.ok}** 只 · 写入 **${s.points}** 点`);
  lines.push(`> 跳过（本地已最新）：**${s.skip}** 只`);
  if (s.fail) lines.push(`> ⚠️ 失败：**${s.fail}** 只${s.lastErr ? '，例：' + s.lastErr : ''}`);
  if (s.degraded) lines.push(`> ⚠️ 部分源降级：${s.lastErr || ''}`);
  lines.push(`> 耗时：${dur}`);
  return lines.join('\n');
}
async function notifyBulk(type, s) {
  try {
    const cfg = wecom.readConfig();
    if (!cfg.enabled) { pushLog(`【${type}】企微通知未发送（未启用）`); return { ok: false, reason: 'disabled' }; }
    const r = await wecom.sendText(buildBulkNotifyText(type, s), { touser: 'huangxuanxin' });
    const ok = r && r.ok;
    pushLog(`【${type}】企微通知${ok ? '已送达' : '发送失败'}（${ok ? 'errcode 0' : JSON.stringify(r && r.raw || r)}）`);
    console.log(`[bulkBackfill][${type}] wecom notify ${ok ? 'ok' : 'fail'}:`, JSON.stringify(r && r.raw || r));
    return r;
  } catch (e) {
    pushLog(`【${type}】企微通知异常：${e.message}`);
    return { ok: false, reason: 'exception', error: e.message };
  }
}

/**
 * 多线程判断一批代码"本地是否已有分时"(仅判断, 不回补)。
 * 把 codes 均分到 min(CPU 数, 8) 个 worker 并行打开各自 .db 判定, 汇总"本地确有分时"的代码集合。
 * worker 线程创建失败(如环境不支持)时回退主线程顺序判断, 保证功能不受影响。
 * @param {string[]} codes
 * @returns {Promise<Set<string>>} 本地确有分时数据的代码集合
 */
function checkLocalIntradayParallel(codes) {
  return new Promise((resolve) => {
    const list = (codes || []).filter(Boolean);
    if (!list.length) return resolve(new Set());
    const workerCount = Math.max(1, Math.min(os.cpus().length || 2, 8, list.length));
    const chunkSize = Math.ceil(list.length / workerCount);
    const chunks = [];
    for (let i = 0; i < list.length; i += chunkSize) chunks.push(list.slice(i, i + chunkSize));
    const hasSet = new Set();
    let pending = chunks.length;
    let fellBack = false;
    const done = () => { if (--pending <= 0) resolve(hasSet); };
    const seqFallback = (arr) => { for (const c of arr) { try { if (intraday.hasLocal(c)) hasSet.add(c); } catch (_) { /* ignore */ } } };
    for (const chunk of chunks) {
      let w = null;
      try {
        w = new Worker(CHECK_WORKER, { workerData: { dbDir: DB_DIR, codes: chunk } });
      } catch (_) {
        fellBack = true; seqFallback(chunk); done(); continue;
      }
      w.on('message', (msg) => { if (msg && Array.isArray(msg.has)) for (const c of msg.has) hasSet.add(c); });
      w.on('error', () => { seqFallback(chunk); }); // 该分片 worker 出错 → 主线程兜底
      w.on('exit', () => { done(); });
    }
    if (fellBack && pending <= 0) resolve(hasSet); // 全部创建失败的极端情况
  });
}

/**
 * 判定分时回补的整只跳过/入队: 两级判断(覆盖索引快路径 + 多线程判断不确定子集)。
 * @param {string[]} codes
 * @returns {Promise<{skip:string[], queue:string[]}>} skip=本地已有分时(直接跳过); queue=本地无分时(排队回补)
 */
async function classifyIntraday(codes) {
  const list = (codes || []).filter(Boolean);
  const skip = [];
  const queue = [];
  // 1) 覆盖索引快路径: 一次批量查, 毫秒级得到每只 intradayDates
  let covMap = new Map();
  try { covMap = gstore.getCoverageMap(list); } catch (_) { covMap = new Map(); }
  const uncertain = [];
  for (const code of list) {
    const cov = covMap.get(code);
    if (cov) {
      if ((cov.intradayDates || 0) > 0) skip.push(code); // 覆盖表权威: 有分时 → 跳过
      else queue.push(code);                              // 覆盖表权威: 无分时 → 排队回补
    } else {
      uncertain.push(code); // 覆盖表无此行(池外代码等)→ 交给多线程判断实测
    }
  }
  // 2) 多线程判断不确定子集(通常为空)
  if (uncertain.length) {
    const hasSet = await checkLocalIntradayParallel(uncertain);
    for (const code of uncertain) (hasSet.has(code) ? skip : queue).push(code);
  }
  return { skip, queue };
}

// type -> job 状态(仅"正在执行"的任务在内存, 供前端实时进度条; 队列与进度持久化于 global.db)
const jobs = {};

// ---------------- 全局任务队列(持久化 + 串行 FIFO, 重启不丢) ----------------
// 任意批量回补请求(分时/5分钟/日线, 全市场或筛选)一律入队(global.db 表 bulk_backfill_queue),
// 同一时刻仅执行队首一个任务, 其余排队等待, 前面任务完成自动取下一个 —— 彻底解决"已有回补在跑时再请求无反应"。
// ★ 持久化: 队列与每任务状态(pending/running/done/error)落库; 服务重启后自动恢复(reset 残留 running→pending 并续跑),
//   进度快照(progress)随每个股票写入, 故"重启不丢失队列与进度"。
let _draining = false;     // 是否有消费者正在顺序处理队列(防止重复启动)
let _activeTaskId = null;  // 当前正在执行的任务 id(供 runJob 写进度快照)

function qdb() { return globalDb(); }

function enqueueTask(type, source, codes, force, days, start, end, targeted) {
  const explicit = (Array.isArray(codes) && codes.length) ? JSON.stringify(codes.filter(Boolean)) : null;
  // days/start/end 仅分时历史回补用到; 其余类型传 undefined(不写列, 落 NULL)
  // targeted: 1=「定向回补」(对比缺失日期补缺, 不做"本地有即整只跳过"快路径), 与实时看盘单只回补语义一致
  const info = qdb().prepare(
    'INSERT INTO bulk_backfill_queue(type,source,codes,force,days,start,end,targeted,status,queued_at) VALUES(?,?,?,?,?,?,?,?,?,?)'
  ).run(type, source || null, explicit, force ? 1 : 0,
        (typeof days === 'number' && days > 0) ? days : null,
        (start && typeof start === 'string') ? start : null,
        (end && typeof end === 'string') ? end : null,
        targeted ? 1 : 0,
        'pending', Date.now());
  const newId = Number(info.lastInsertRowid);
  // 位次 = 排在它前面(更小 id)且仍 pending/running 的任务数 + 1(与到达顺序一致)
  const ahead = qdb().prepare(
    "SELECT COUNT(*) c FROM bulk_backfill_queue WHERE status IN ('pending','running') AND id < ?"
  ).get(newId).c;
  return { id: newId, position: ahead + 1 };
}

// 把"正在执行"任务的实时进度写入 DB 快照(每个股票一次, 轻量 UPDATE; 崩溃后据此恢复时不丢进度信息)
function persistProgress(taskId, job) {
  if (!taskId) return;
  try {
    qdb().prepare('UPDATE bulk_backfill_queue SET progress=? WHERE id=?').run(
      JSON.stringify({ total: job.total, done: job.done, ok: job.ok, fail: job.fail, skip: job.skip, points: job.points, currentCode: job.currentCode, phase: job.phase }),
      taskId
    );
  } catch (_) { /* ignore */ }
}

async function drainQueue() {
  if (_draining) return;  // 已有消费者在跑, 本次调用直接返回(不重复启动)
  _draining = true;
  try {
    while (true) {
      const task = qdb().prepare(
        "SELECT * FROM bulk_backfill_queue WHERE status='pending' ORDER BY queued_at ASC, id ASC LIMIT 1"
      ).get();
      if (!task) break;
      _activeTaskId = task.id;
      const pendingLeft = qdb().prepare("SELECT COUNT(*) c FROM bulk_backfill_queue WHERE status='pending'").get().c - 1;
      qdb().prepare("UPDATE bulk_backfill_queue SET status='running', started_at=? WHERE id=?").run(Date.now(), task.id);
      pushLog(`【${task.type}】队列任务开始执行（队列剩余 ${pendingLeft}）`);
      // 解析股票列表(全市场需异步拉取股票池, 并过滤退市)
      let list = task.codes ? JSON.parse(task.codes) : [];
      try {
        const uni = await universe.getUniverse();
        const delSet = new Set(uni.stocks.filter((s) => s.delisted).map((s) => s.code));
        if (!list.length) list = uni.stocks.map((s) => s.code);
        list = list.filter((c) => !delSet.has(c));
      } catch (_) { /* 异常时不过滤, 保持原行为 */ }
      if (!list.length) {
        qdb().prepare("UPDATE bulk_backfill_queue SET status='done', finished_at=?, progress=? WHERE id=?")
          .run(Date.now(), JSON.stringify({ done: 0, ok: 0, fail: 0, skip: 0, points: 0 }), task.id);
        pushLog(`【${task.type}】队列任务跳过（无有效股票）`);
        _activeTaskId = null;
        continue;
      }
      const job = initJob(task.type, task.source, list, !!task.force);
      // 分时历史回补深度/区间: 从队列行读取(days/start/end, 可能为 null=全量)
      const taskDays = (typeof task.days === 'number' && task.days > 0) ? task.days : null;
      const taskStart = (task.start && typeof task.start === 'string') ? task.start : null;
      const taskEnd = (task.end && typeof task.end === 'string') ? task.end : null;
      const taskTargeted = !!task.targeted; // 1=定向回补(对比缺失日期, 不做整只跳过)
      try {
        await runJob(task.type, task.source, list, !!task.force, taskDays, taskStart, taskEnd, taskTargeted);
        persistProgress(_activeTaskId, job); // 终态进度快照(确保完成态也落库)
        qdb().prepare("UPDATE bulk_backfill_queue SET status='done', finished_at=? WHERE id=?").run(Date.now(), task.id);
      } catch (e) {
        job.finished = true; job.error = e.message;
        persistProgress(_activeTaskId, job);
        qdb().prepare("UPDATE bulk_backfill_queue SET status='error', error=?, finished_at=? WHERE id=?").run(e.message, Date.now(), task.id);
        pushLog(`【${task.type}】队列任务异常终止：${e.message}`);
      }
      _activeTaskId = null;
    }
  } finally {
    _draining = false;
  }
}

// 启动时恢复: 把上次崩溃残留的 running 重置为 pending 重新执行(幂等), 并续跑队列; 同时清理过期已完成任务。
function recoverQueue() {
  try {
    const reset = qdb().prepare("UPDATE bulk_backfill_queue SET status='pending' WHERE status='running'").run();
    if (reset.changes) pushLog(`【恢复】检测到 ${reset.changes} 个上次运行中残留的任务，已重置为待执行并续跑`);
    // 清理 7 天前已完成的任务, 避免表无限增长
    const cutoff = Date.now() - 7 * 86400 * 1000;
    const pruned = qdb().prepare("DELETE FROM bulk_backfill_queue WHERE status IN ('done','error') AND finished_at < ?").run(cutoff);
    if (pruned.changes) pushLog(`【恢复】清理 ${pruned.changes} 条过期已完成队列记录`);
  } catch (_) { /* ignore */ }
  // 不阻塞启动: 异步续跑, 失败记入日志不崩溃
  drainQueue().catch((e) => { _draining = false; pushLog('队列消费者异常退出: ' + e.message); });
}

function localKlineExists(period, code) {
  return period === '5m' ? ms.has5min(code) : ms.hasDay(code);
}

// 各类型回补的默认源: 分时→intradayBackfill; 5分钟/日线由 loadBars 内部按 cfg.min5/cfg.day 决定(此处传 undefined)
function defaultSource(type) {
  if (type === 'intraday') return dataSource.readConfig().intradayBackfill; // 默认 tdx
  return undefined; // 5min/day 交给 loadBars 按配置选择
}

function initJob(type, source, list, force) {
  jobs[type] = {
    type, source: source || defaultSource(type),
    total: list.length, done: 0, ok: 0, fail: 0, skip: 0,
    points: 0, // 累计写入的数据点(分时点 / K线根), 供前端显示"已写入 X 点"
    startedAt: Date.now(), finished: false, currentCode: null, error: null,
    lastErr: null, force: !!force, degraded: false, // degraded: 任一股票数据源降级(供前端分状态)
    phase: null, // 分时: 'judging'(多线程判断本地有无) → 'backfilling'(排队回补); 其余类型为 null
  };
  return jobs[type];
}

async function runJob(type, source, list, force, days, start, end, targeted) {
  const job = jobs[type];
  // 分时历史回补深度/区间: 全量哨兵 5000(=本地缺失全补); 用户显式 days<5000 或日期区间视为"定向回补"
  const FULL_SENTINEL = 5000;
  // 是否"定向回补": 显式 targeted 标志 或 (days<全量哨兵 或 日期区间)。定向回补 = 与实时看盘单只回补一致,
  // 不判断"本地有无分时"整只跳过, 而是 fetchAndStore 内部对比"目标窗口内缺失日期"精确补缺(只补缺, 已有的不动)。
  const derivedTargeted = (typeof days === 'number' && days > 0 && days < FULL_SENTINEL) || !!(start && end);
  const isTargeted = !!targeted || derivedTargeted;
  const rangeMode = !!(start && end);
  job.days = (typeof days === 'number' && days > 0) ? days : null;
  job.start = start || null;
  job.end = end || null;
  job.targeted = isTargeted; // 供结果汇总/企微/前端展示"对比缺失日期"语义
  const depthLabel = rangeMode ? `日期区间 ${start}~${end}` : (derivedTargeted ? `最近 ${days} 交易日` : (isTargeted ? '全量历史(对比缺失日期)' : '全量历史'));
  pushLog(`【${type}】开始批量回补：${list.length} 只${force ? '（强制刷新）' : '（仅补缺）'}${isTargeted ? ' · 定向回补(对比缺失日期补缺, 不整只跳过)' : ''} · 数据源=${srcLabel(job.source)} · 分时深度=${depthLabel} · 独立限流≈${Math.round(1000 / BULK_GAP_MS)}次/秒`);
  // 分时: 仅"非定向 + 非强制"时才做「本地有无分时」的整体整只跳过快路径(覆盖索引 + 多线程), 本地有分时的直接跳过零请求。
  // ★ 定向回补(targeted) / 强制刷新(force) 时不做整只跳过 —— 直接入队, 由 fetchAndStore 按目标窗口内的"缺失日期"
  //   精确补缺(已有日期不动), 与实时看盘页单只历史回补语义完全一致(见 intraday.backfill -> fetchAndStore)。
  //   force=true 时也走 fetchAndStore 补缺(对分时而言 force 不改变"只写缺失日期"语义, 仅抑制整只跳过)。
  let queue = list;
  if (type === 'intraday' && !isTargeted) {
    job.phase = 'judging'; // 判断阶段: 前端可显示"正在判断本地数据(多线程)"
    let skipList = [];
    try {
      const r = await classifyIntraday(list);
      skipList = r.skip; queue = r.queue;
    } catch (_) {
      queue = list; // 判断异常 → 退回全量走回补循环(fetchAndStore 内部仍会按本地日期过滤兜底)
    }
    job.skip += skipList.length;
    job.done += skipList.length; // 已判定跳过的计入完成, 进度条正确反映
    persistProgress(_activeTaskId, job); // 判断阶段进度也落库
    job.phase = 'backfilling';
    if (skipList.length) pushLog(`【${type}】本地已有分时的 ${skipList.length} 只直接跳过（零请求）`);
  }
  for (const code of queue) {
    job.currentCode = code;
    // 独立限流闸门(与 dailySync / 单只回补的限流均隔离): 保证相邻请求间隔 >= BULK_GAP_MS
    try { await bulkAcquire(); } catch (_) { /* 不影响主流程 */ }
    try {
      if (type === 'intraday') {
        // 分时: 复用核心函数, 内部已按本地日期过滤; days 给大值让 TDX 尽量深、东财按其硬上限(5)
        // source 缺省时由 defaultSource 回填为 cfg.intradayBackfill(默认 tdx), 不再硬编码 eastmoney
        // ★ 提速关键: 把批量回补专属限流器 bulkAcquire(150ms) 透传给 TDX 分页循环,
        //   取代 provider 内默认的全局 1次/秒限流 —— 单只股票由"每页1秒"降为"每页150ms"(≈6.7倍),
        //   且不触碰数据源封禁风险(自托管网关); 单只回补按钮仍走全局限流(见 intradayRecorder 不传 limiter)。
        // 定向回补: 把 days/start/end 透传给 fetchAndStore, 只回补目标窗口内缺失的交易日。
        const primary = isIndexCode(code) ? 'eastmoney' : (source || defaultSource('intraday')); // 指数禁用 TDx(返回损坏序列), 主源改东财
        const fdays = (typeof days === 'number' && days > 0) ? days : FULL_SENTINEL;
        let r = await intraday.fetchAndStore(code, { days: fdays, source: primary, start: start || null, end: end || null, limiter: bulkAcquire });
        // ★ 降级链(关键修复): fetchAndStore 自身对 intraday 无任何兜底 —— 首选源(默认 tdx)不可达/降级时,
        //   原逻辑直接记失败(job.fail++), 导致"TDX 网关未起"时**全市场分时回补整类失败**(大盘指数首当其冲)。
        //   本环境现状: TDX 网关未部署(TDX_ENDPOINT 空) 且 东财 push2his 被网络拦截(fetch failed) —— 两历史源均不可达;
        //   腾讯 getMinute 是唯一稳定可达的 intraday 源(真1分钟、对指数/股票均生效、仅当日)。
        //   降级链: tdx(主) → 东财 trends2(≤5交易日, 未来解封仍可用) → 腾讯当日分时(当前兜底, 保证"有正常数据")。
        if (r && r.degraded) {
          // 1) 东财 trends2(仅当主源为 tdx 时尝试; 指数主源已设为东财, 此处跳过避免重复):
          //    仅当东财"真正写入数据"或"判定本地已追平"才算成功;
          //    否则(东财降级 / 网络不通返回 ok:true 但 written:0 的空结果)继续走腾讯兜底, 不得吞掉降级。
          if (primary === 'tdx') {
            const em = await intraday.fetchAndStore(code, { days: fdays, source: 'eastmoney', start: start || null, end: end || null, limiter: bulkAcquire });
            const emWrote = em && !em.degraded && (em.written > 0 || em.points > 0);
            const emUpToDate = em && !em.degraded && em.upToDate;
            if (emWrote) r = em;         // 东财拿到新数据 → 采用
            else if (emUpToDate) r = em; // 东财判定本地已追平(零请求) → 成功, 不触发腾讯兜底
            // 其余(东财降级/空结果/抓取失败) → 保留 r=degraded, 继续走腾讯兜底
          }
        }
        // 2) 腾讯当日分时(最终兜底): 主源(含东财对指数)未拿到有效数据时写入, 保证"有正常数据"。
        //    注意: 该兜底不能包在上面的 `if(r.degraded)` 内 —— 指数主源=东财被网络拦截时
        //    fetchAndStore 返回的是 ok:true 但 written:0 的"空成功"(非 degraded), 若只在 degraded 时才兜底,
        //    会漏掉这类"返回空结果"的情况, 导致指数分时整类 0 行。故放在 degraded 判定之外,
        //    以"未写入有效数据"为兜底触发条件。
        if (r && (r.degraded || !(r.written > 0 || r.points > 0 || r.upToDate))) {
          try {
            const rows = await tencent.getMinute(code); // 当前交易日整日 1 分钟分时(≈240点)
            if (rows && rows.length) {
              const w = ms.saveIntraday(code, intraday.todayStr(), rows); // 已过滤脏数据, 返回有效行数
              if (w > 0) {
                r = {
                  ok: true, source: 'tencent', days: 1, points: w, dates: [intraday.todayStr()],
                  written: 1, skippedExisting: 0, capped: null, rangeCapped: null,
                };
                job.degraded = true; job.lastErr = `${code}: 历史源不可用, 已降级到腾讯当日分时`;
              }
              // w===0 → 腾讯也返回了脏数据, 保留 r 失败/降级结论
            }
          } catch (_) { /* 腾讯也失败 → 保留 degraded 结论, 最终记 fail */ }
        }
        if (r && r.upToDate) job.skip++;
        else if (r && (r.written > 0 || r.ok)) job.ok++;
        else job.fail++;
        if (r && r.degraded) { job.degraded = true; if (!job.lastErr) job.lastErr = `${code}: ${r.reason || '降级'}`; }
        if (r && r.points) job.points += r.points; // 累计分时数据点
      } else {
        const period = type === '5min' ? '5m' : 'day';
        if (!force && localKlineExists(period, code)) { job.skip++; continue; }
        const { bars, source: src } = await loadBars(code, period, { force: true });
        if (bars && bars.length) { job.ok++; job.points += bars.length; }
        else { job.fail++; job.lastErr = `${code}: 无数据(${src})`; }
      }
    } catch (e) {
      job.fail++;
      job.lastErr = `${code}: ${e.message}`;
    }
    job.done++;
    persistProgress(_activeTaskId, job); // 进度快照落库(崩溃后重启可据此恢复, 不丢进度)
  }
  job.finished = true;
  job.currentCode = null;
  // 结果汇总 + 执行日志 + 企微通知
  const summary = {
    type,
    source: job.source,
    total: job.total, ok: job.ok, fail: job.fail, skip: job.skip,
    points: job.points, degraded: job.degraded, lastErr: job.lastErr,
    force: job.force,
    targeted: !!job.targeted, // 定向回补(对比缺失日期, 不整只跳过)
    days: job.days || null, start: job.start || null, end: job.end || null,
    startedAt: new Date(job.startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - job.startedAt,
  };
  _lastResults[type] = summary;
  try { setMeta('bulk_backfill_status', JSON.stringify(_lastResults)); } catch (_) { /* ignore */ }
  const pureSkip = (job.ok === 0 && job.fail === 0 && !job.degraded && job.skip > 0);
  const line = `【${type}】回补完成：${summary.total}只 · 成功${summary.ok} · 跳过${summary.skip} · 失败${summary.fail} · 写入${summary.points}点 · 耗时${Math.round(summary.durationMs / 1000)}s${job.degraded ? ' · 部分源降级' : ''}`;
  pushLog(line);
  console.log('[bulkBackfill] ' + line);
  // 仅"真实回补/失败/降级"时通知; 全部已是本地最新(纯跳过)不发企微, 避免刷屏
  if (!pureSkip) notifyBulk(type, summary).catch(() => {});
}

/**
 * 启动一个批量回补任务(统一进入全局串行队列, 绝不丢弃请求)
 * @param {'intraday'|'5min'|'day'} type
 * @param {{source?:string, codes?:string[], force?:boolean, days?:number, start?:string, end?:string}} opt
 *   codes 省略则回补全市场; days/start/end 仅分时历史回补用到(与单只历史回补一致)
 * @returns {{queued:true, position:number, type}}
 */
function startJob(type, { source, codes, force, days, start, end, targeted } = {}) {
  const explicit = Array.isArray(codes) ? codes.filter(Boolean) : [];
  const r = enqueueTask(type, source, explicit, force, days, start, end, targeted); // 入队(已存在运行中的任务也不丢, 只是排后面)
  drainQueue();                                          // 启动/唤醒消费者(已有 running 时立即返回, 不重复启动)
  return { queued: true, position: r.position, taskId: r.id, type };
}

function getJob(type) { return jobs[type] || null; }
function getStatus() {
  let queue = [];
  let queueLength = 0;
  let running = null;
  try {
    // 队列(仅待执行任务): 前端用于显示"排队中"横幅 —— 直接读持久化表, 重启后仍准确
    queue = qdb().prepare("SELECT id,type,force,days,start,end,targeted,queued_at FROM bulk_backfill_queue WHERE status='pending' ORDER BY queued_at ASC, id ASC").all();
    queueLength = queue.length;
    // 正在执行中的任务(若有)
    running = qdb().prepare("SELECT id,type,force,days,start,end,targeted,started_at FROM bulk_backfill_queue WHERE status='running' LIMIT 1").get() || null;
  } catch (_) { /* ignore */ }
  return {
    jobs: Object.keys(jobs).map((t) => ({ type: t, ...jobs[t] })),
    logs: _logs,
    lastResults: _lastResults,
    queue: queue.map((t) => ({ id: t.id, type: t.type, force: !!t.force, days: (typeof t.days === 'number' && t.days > 0) ? t.days : null, start: t.start || null, end: t.end || null, targeted: !!t.targeted, queuedAt: t.queuedAt })),
    queueLength,
    running: running ? { id: running.id, type: running.type, force: !!running.force, days: (typeof running.days === 'number' && running.days > 0) ? running.days : null, start: running.start || null, end: running.end || null, targeted: !!running.targeted, startedAt: running.started_at } : null,
    draining: _draining,
  };
}

module.exports = { startJob, getJob, getStatus, classifyIntraday, checkLocalIntradayParallel, bulkAcquire, recoverQueue };

// ---------------- 启动时自动恢复队列(重启不丢) ----------------
// 服务启动(本模块首次被 require)即把上次遗留的 running 任务重置为 pending 并续跑队列,
// 确保"系统重启后回补队列继续、不丢失队列与进度"。
try { recoverQueue(); } catch (_) { /* 启动恢复失败不应阻断服务 */ }
