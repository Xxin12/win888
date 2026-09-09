'use strict';
/**
 * 通daxin(TDX) 历史分时提供层 —— 可插拔 (pluggable)
 *
 * 现状约束:
 *  - 系统侧无法直接连 TDX(本机无 vipdoc, 公共 TDX TCP 服务器沙箱不可达)。
 *  - TDX 数据当前由 agent 经 TDX 连接器(MCP)手动回补(已验证可用)。
 *  - 因此本 provider 设计为「可插拔」: 仅当配置了 TDX_ENDPOINT(指向一个 HTTP 网关,
 *    例如部署的 TDX 代理 / agent 连接器暴露的 HTTP 服务)时才可用; 否则 available()=false,
 *    getIntradayRange 返回 degraded 提示, 由前端引导用户走「agent 手动回补」或「部署网关」。
 *
 * 频率限制(防封禁)—— 即使配置了网关也严格遵守:
 *  - 单只股票分页串行, 每页之间 sleep TDX_PAGE_GAP_MS(默认 2000ms, 与 agent 实测一致)。
 *  - 无并发; 失败指数退避(2s,4s,8s), 最多重试 TDX_MAX_RETRY 次。
 *  - 单只回补页数上限封顶(maxPages), 避免一次抓太多被封。
 *  - 分页参数沿用 agent 实测: period=7(1分钟线)、wantNum=1000(满页~700根)、startxh 步长 680。
 *
 * 约定网关接口(供部署网关时对齐, 见 server/gateway/tdx_gateway.py):
 *  GET {TDX_ENDPOINT}/kline?code=600031&setcode=1&period=7&startxh=0&wantNum=800&tqFlag=1
 *    Header: Authorization: Bearer <TDX_TOKEN>  (网关设了 token 时必带)
 *  成功返回 JSON: { ok:true, rows:[{ time:'YYYY-MM-DD HH:MM', price, volume, amount }] }
 *  注意: 网关只回"每根原始量/额"(raw per-bar)。日累计量 cumVolume 与日均价 avg
 *        (=amount/(vol*100)) 由本 provider 收齐所有分页、排序去重后按日累加得到 ——
 *        因为分页窗口可能切在日内, 让网关算累计会错乱, 故放到 client 全量聚合时算。
 */
// 端点/Token 运行时动态读取: 支持由 GatewayManager 在 Web 启动网关后回写 process.env,
// 无需重启 server 即可让本 provider 生效。
function getEndpoint() { return (process.env.TDX_ENDPOINT || '').replace(/\/+$/, ''); }
function getToken() { return (process.env.TDX_TOKEN || '').trim(); }
const rate = require('../lib/backfillRate'); // 全局请求限流(每秒最多1次), 每次 fetch 前 acquire

// 并发去重: 同一 code+类别的 K线抓取合并为一次(避免多个调用方并发各起一个分页循环, 打爆网关/限流预算)。
// 例: 同时打开多张图表/跑回测都会调 get5minKline, 合并后只有一个分页循环在跑(日志里 startxh 才单调递增)。
const _tdxInflight = new Map();
function dedupeTdx(key, fn) {
  if (_tdxInflight.has(key)) return _tdxInflight.get(key);
  const p = Promise.resolve().then(fn).finally(() => _tdxInflight.delete(key));
  _tdxInflight.set(key, p);
  return p;
}
const TDX_MAX_RETRY = parseInt(process.env.TDX_MAX_RETRY || '3', 10);       // 失败重试
const TDX_PAGE_ROWS = 800;      // 每页 wantNum(pytdx 单次上限 800)
const TDX_STEP = 680;           // startxh 步长(<800 实际行/页, 相邻页重叠去重补空洞)
const ROWS_PER_DAY = 240;       // 1分钟线每个交易日约 240 根
// 不再对回补天数人为封顶: 回溯深度由"服务器真实数据 floor"自然截断(取到空页即停)。
// TDX_MAX_PAGES 仅作极宽松的安全上限, 防止异常情况下的无限循环(正常远够不到, 可 env 调)。
const TDX_MAX_PAGES = parseInt(process.env.TDX_MAX_PAGES || '400', 10);
// null = 不封顶(历史深度以数据 floor 为准); 保留导出仅为兼容(dataSource 会据此显示"不封顶")
const TDX_MAX_DAYS = null;

function available() { return !!getEndpoint(); }
function unavailableReason() {
  return 'TDX_ENDPOINT 未配置：通daxin 分时在当前系统侧不可直接获取。可选项：(1) 由 agent 经 TDX 连接器手动回补(已验证可用)；(2) 部署 TDX HTTP 网关后设置环境变量 TDX_ENDPOINT。';
}

function setcodeOf(code) {
  if (code.startsWith('sh')) return '1';
  if (code.startsWith('sz')) return '0';
  if (code.startsWith('bj')) return '8';
  // 纯数字形式按首字符判断市场
  return String(code || '').startsWith('6') ? '1' : '0';
}
function shortOf(code) { return String(code || '').replace(/^(sh|sz|bj)/, ''); }

/**
 * TDX 公共节点返回的「成交量」单位不一致: 部分节点返回 股(shares), 部分返回 手(lots)。
 * 不能写死单位, 否则 avg(VWAP) 会差 100 倍(均价≈0.11 而非≈11)。
 * 这里用「成交额 ≈ 现价 × 成交量」的关系逐页判定单位, 并把成交量归一为 手(lots):
 *   amount / (price * volume) ≈ 1   -> 量是股(shares) -> 换算成手需 /100
 *   amount / (price * volume) ≈ 100 -> 量是手(lots)    -> 直接使用
 * 逐页判定是因为网关的故障切换池可能在不同分页打到不同节点, 单位会跨页变化。
 * @returns rows 中 volume 已被归一为 手(lots)
 */
function normVolumeUnit(rows) {
  const ratios = [];
  for (const r of rows) {
    const p = parseFloat(r.price), v = parseFloat(r.volume), a = parseFloat(r.amount);
    if (!(p > 0) || !(v > 0) || !(a > 0)) continue;
    ratios.push(a / (p * v)); // ≈1 表示股(shares); ≈100 表示手(lots)
  }
  let unit = 'lots';
  if (ratios.length) {
    ratios.sort((x, y) => x - y);
    const med = ratios[Math.floor(ratios.length / 2)];
    unit = med < 10 ? 'shares' : 'lots';
  }
  const factor = unit === 'shares' ? 0.01 : 1;
  return rows.map((r) => ({
    time: r.time,
    price: r.price,
    amount: parseFloat(r.amount) || 0,
    volume: (parseFloat(r.volume) || 0) * factor, // 归一为手
  }));
}

/** 把限流器规整成"调用一次即等待一个间隔"的函数。
 *  兼容两种形态: 1) 函数(如 bulkAcquire, 直接 await 调用); 2) 对象(如全局 rate, 调 .acquire())。 */
function acquireOf(limiter) {
  const rl = limiter || rate;
  if (typeof rl === 'function') return () => rl();
  if (rl && typeof rl.acquire === 'function') return () => rl.acquire();
  return () => Promise.resolve(); // 兜底: 无有效限流器时不阻塞
}

/** 抓取单页(自带指数退避重试)。返回 rows 数组或 null(彻底失败)
 *  @param {Function|{acquire:Function}} [limiter] 限流器。函数(bulkAcquire)或含 .acquire() 的对象(全局 rate)皆可。
 *        默认用全局 backfillRate(1次/秒); 批量回补时由调用方传入 bulkAcquire(150ms), 提速且不触发源限流(自托管网关无封禁风险)。 */
async function fetchPage(code, setcode, startxh, attempt = 0, limiter) {
  const endpoint = getEndpoint();
  const url = `${endpoint}/kline?code=${encodeURIComponent(shortOf(code))}` +
    `&setcode=${setcode}&period=7&startxh=${startxh}&wantNum=${TDX_PAGE_ROWS}&tqFlag=1`;
  await acquireOf(limiter)(); // 限流: 默认全局(1次/秒); 批量回补传入 bulkAcquire(150ms) 提速
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    const headers = { 'User-Agent': 'quant-web/1.0' };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await fetch(url, { signal: ctrl.signal, headers });
    clearTimeout(timer);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    return (j && j.rows) || [];
  } catch (e) {
    if (attempt < TDX_MAX_RETRY) {
      const backoff = 2000 * Math.pow(2, attempt); // 2s, 4s, 8s
      await new Promise((r) => setTimeout(r, backoff));
      return fetchPage(code, setcode, startxh, attempt + 1, limiter);
    }
    return null; // 彻底失败
  }
}

/**
 * 分页回补单只股票最近 days 个交易日 1分钟线
 * @returns Promise<{byDate,dates,points,capped,degraded?,reason?}>
 */
async function getIntradayRange(code, { days = 5, start = null, end = null, onProgress = null, neededOldest = null, limiter = null } = {}) {
  if (!available()) {
    return { byDate: {}, dates: [], points: 0, capped: null, degraded: true, reason: unavailableReason() };
  }
  const setcode = setcodeOf(code);
  const needRows = Math.max(days, 1) * ROWS_PER_DAY;
  // 按"实际步进"(TDX_STEP)估页数, 因每页真实前进量≈步长(不是 wantNum)。
  // expectedPages 仅用于进度条展示; maxPages 是"安全上限"(防死循环), 天数本身不封顶,
  // 实际会在"抓到最早缺失日 neededOldest"或"服务器数据 floor(空页)"处提前停止。
  const expectedPages = Math.ceil(needRows / TDX_STEP) + 1;
  const maxPages = Math.min(expectedPages + 1, TDX_MAX_PAGES);
  const reportTotal = Math.min(expectedPages, maxPages);
  if (typeof onProgress === 'function') onProgress({ stage: '开始抓取分时', currentPage: 0, totalPages: reportTotal });
  // 1) 先把所有分页原始行收集起来(网关分页有重叠, 不能边收边按页 append)。
  //    网关返回的是每根原始量/额: { time, price, volume(手), amount(元) }。
  const allRows = [];
  const dateSet = new Set();
  let fetchFailed = false;   // 任一页抓取彻底失败(重试后仍 null, 即网关不可达)
  let gotAnyRows = false;    // 是否曾拿到过有效数据(用于区分"网关挂了"与"真的没数据")
  for (let i = 0; i < maxPages; i++) {
    const startxh = i * TDX_STEP;
    const rows = await fetchPage(code, setcode, startxh, 0, limiter); // eslint-disable-line no-await-in-loop
    if (rows === null) { fetchFailed = true; break; } // 抓取失败, 停止
    if (!rows.length) break;        // 已到最早数据
    gotAnyRows = true;
    // 逐页归一成交量单位(手/股可能跨页变化), 再入库
    const norm = normVolumeUnit(rows);
    for (const r of norm) {
      allRows.push(r);
      if (r && r.time) dateSet.add(String(r.time).slice(0, 10));
    }
    // 进度上报(每页一报): 当前页 / 总页数 + 已抓天数 / 根数
    if (typeof onProgress === 'function') {
      onProgress({
        stage: `抓取第 ${i + 1}/${reportTotal} 页`,
        currentPage: Math.min(i + 1, reportTotal),
        totalPages: reportTotal,
        dates: dateSet.size,
        points: allRows.length,
      });
    }
    // 频率控制由全局限流器(每次 fetch 前 rate.acquire, 每秒≤1次)统一负责, 此处不再额外 sleep。
    // 提前停止(减少请求):
    //   - 若指定了"最早缺失日 neededOldest": 抓到比它更早的日期即可停(多抓1天用于丢半天边界);
    //   - 否则退回按"覆盖天数"停止(多抓1天冗余)。
    if (neededOldest) {
      const minFetched = dateSet.size ? [...dateSet].reduce((m, d) => (d < m ? d : m)) : null;
      if (minFetched && minFetched < neededOldest) break;
    } else if (dateSet.size > days) {
      break;
    }
  }
  // 1.5) 网关不可达检测: 端点已配置但首屏抓取即彻底失败(重试后仍 null),
  //      说明网关未运行/已退出。此时不应静默返回"回补0天", 而要明确降级提示,
  //      引导用户在「🧩 TDX 网关」页启动网关。
  if (fetchFailed && !gotAnyRows) {
    return {
      byDate: {}, dates: [], points: 0, capped: null,
      degraded: true,
      reason: 'TDX 网关不可达：TDX_ENDPOINT 已配置（' + getEndpoint() +
        '）但请求无响应。请在「🧩 TDX 网关」页面确认网关处于「运行中」' +
        '（若已停止，请先点「启动网关」），再执行回补。',
    };
  }
  // 2) 全局按 time 升序 + 按 time 去重(跨页重叠根只保留首现)
  allRows.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  const seen = new Set();
  const byDate = {};
  let prevDate = null, cumVol = 0, cumAmt = 0;
  for (const r of allRows) {
    if (!r || !r.time || seen.has(r.time)) continue; // 去重(重叠分页)
    seen.add(r.time);
    const sp = String(r.time).split(' ');
    const date = sp[0];
    const t = sp[1] ? sp[1].slice(0, 5) : '';
    const price = parseFloat(r.price);
    if (!isFinite(price)) continue;
    const barVol = parseFloat(r.volume) || 0;  // 每根成交量(手)
    const barAmt = parseFloat(r.amount) || 0;  // 每根成交额(元)
    // 3) 按日累加, 得到日累计量 cumVolume 与日均价 avg(=累计额/(累计量*100股/手))
    if (date !== prevDate) { prevDate = date; cumVol = 0; cumAmt = 0; }
    cumVol += barVol;
    cumAmt += barAmt;
    const avg = cumVol > 0 ? +(cumAmt / (cumVol * 100)).toFixed(3) : price;
    (byDate[date] = byDate[date] || []).push({
      t, price, avg, volume: +barVol.toFixed(2), cumVolume: +cumVol.toFixed(2),
    });
  }
  // 4) 丢弃"半天"边界日: 首根不在开盘附近(>09:35)说明该日被分页切断, 累计量不完整
  for (const d of Object.keys(byDate)) {
    const first = byDate[d][0];
    if (!first || first.t > '09:35') delete byDate[d];
  }
  // 5) 日期区间过滤(若指定 start/end): 仅保留区间内的日期, 并判定起始日是否触及
  let rangeCapped = null;
  if (start || end) {
    const lo = start || '0000-00-00';
    const hi = end || '9999-99-99';
    const allDates = Object.keys(byDate);
    const rangeStart = allDates.length ? allDates.reduce((a, b) => (a < b ? a : b)) : null;
    for (const d of allDates) { if (d < lo || d > hi) delete byDate[d]; }
    // 最早已抓取日仍晚于 start(起始日超出可回补深度) -> 区间被截断
    if (start && rangeStart && rangeStart > start) rangeCapped = rangeStart;
  }
  const dates = Object.keys(byDate).sort((a, b) => (a < b ? 1 : -1));
  const points = dates.reduce((n, d) => n + byDate[d].length, 0);
  const capped = dates.length < days ? dates.length : null;
  if (typeof onProgress === 'function') {
    onProgress({ stage: '聚合/落盘中', currentPage: reportTotal, totalPages: reportTotal, dates: dates.length, points });
  }
  return { byDate, dates, points, capped, rangeCapped };
}

/** 抓取单页 K 线(带 category, 自带指数退避重试)。返回 rows 数组或 null(彻底失败) */
async function fetchCategoryPage(code, setcode, category, startxh, attempt = 0) {
  const endpoint = getEndpoint();
  const url = `${endpoint}/kline?code=${encodeURIComponent(shortOf(code))}` +
    `&setcode=${setcode}&category=${category}&startxh=${startxh}&wantNum=${TDX_PAGE_ROWS}&tqFlag=1`;
  await rate.acquire(); // 全局限流: 保证与上一次请求间隔 >= 1s
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    const headers = { 'User-Agent': 'quant-web/1.0' };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await fetch(url, { signal: ctrl.signal, headers });
    clearTimeout(timer);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    return (j && j.rows) || [];
  } catch (e) {
    if (attempt < TDX_MAX_RETRY) {
      const backoff = 2000 * Math.pow(2, attempt); // 2s, 4s, 8s
      await new Promise((r) => setTimeout(r, backoff));
      return fetchCategoryPage(code, setcode, category, startxh, attempt + 1);
    }
    return null; // 彻底失败
  }
}

/**
 * 经网关分页拉取某类别 K 线(日线=4 / 5分钟=0), 归一成交量单位(手), 排序去重。
 * @returns {Promise<{bars?:Array,degraded?:bool,reason?:string}>}
 */
async function fetchCategory(code, category, datalen = 5001) {
  if (!available()) {
    return { degraded: true, reason: unavailableReason() };
  }
  const setcode = setcodeOf(code);
  const allRows = [];
  const maxPages = Math.min(Math.ceil(datalen / TDX_STEP) + 2, TDX_MAX_PAGES);
  let fetchFailed = false, gotAny = false;
  for (let i = 0; i < maxPages; i++) {
    const startxh = i * TDX_STEP;
    const rows = await fetchCategoryPage(code, setcode, category, startxh); // eslint-disable-line no-await-in-loop
    if (rows === null) { fetchFailed = true; break; }
    if (!rows.length) break;
    gotAny = true;
    const norm = normVolumeUnit(rows); // 逐页归一成交量(手/股可能跨页变化)
    const volByTime = {};
    norm.forEach((r) => { volByTime[r.time] = r.volume; }); // 归一后 volume 按 time 归位
    for (const r of rows) {
      const v = volByTime[r.time];
      if (v === undefined) continue;
      allRows.push({ time: r.time, open: r.open, high: r.high, low: r.low, close: r.close, volume: v, amount: r.amount });
    }
    if (allRows.length >= datalen) break;
    // 频率控制由全局限流器统一负责(每次 fetch 前 rate.acquire), 此处不再额外 sleep。
  }
  if (fetchFailed && !gotAny) {
    return {
      degraded: true,
      reason: 'TDX 网关不可达：TDX_ENDPOINT 已配置（' + getEndpoint() +
        '）但请求无响应。请在「🧩 TDX 网关」页面确认网关处于「运行中」再试。',
    };
  }
  // 全局按 time 升序 + 去重(跨页重叠根只保留首现)
  allRows.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  const seen = new Set();
  const out = [];
  for (const r of allRows) {
    if (!r || !r.time || seen.has(r.time)) continue;
    seen.add(r.time);
    const vol = parseFloat(r.volume) || 0;
    out.push({
      time: r.time,
      open: parseFloat(r.open), high: parseFloat(r.high), low: parseFloat(r.low), close: parseFloat(r.close),
      volume: +vol.toFixed(2),
      amount: +(parseFloat(r.amount) || 0).toFixed(2),
    });
  }
  return { bars: out };
}

/**
 * TDX 日K线 (经网关 category=4)
 * @returns {Promise<Array<{date,open,high,low,close,volume,amount}>|{degraded,reason}>}
 *  注意: 网关未配置/不可达时返回 {degraded:true,reason}, 调用方需据此降级兜底。
 */
async function getDayKline(code, { datalen = 5001 } = {}) {
  return dedupeTdx(`day:${shortOf(code)}:${datalen}`, async () => {
    const res = await fetchCategory(code, 4, datalen);
    if (res && res.degraded) return res;
    return (res.bars || []).map((b) => ({
      date: String(b.time).slice(0, 10),
      open: b.open, high: b.high, low: b.low, close: b.close,
      volume: b.volume, amount: b.amount,
    }));
  });
}

/**
 * TDX 5分钟K线 (经网关 category=0)
 * @returns {Promise<Array<{datetime,date,open,high,low,close,volume,amount}>|{degraded,reason}>}
 */
async function get5minKline(code, { datalen = 5001 } = {}) {
  return dedupeTdx(`5m:${shortOf(code)}:${datalen}`, async () => {
    const res = await fetchCategory(code, 0, datalen);
    if (res && res.degraded) return res;
    return (res.bars || []).map((b) => ({
      datetime: b.time,
      date: String(b.time).slice(0, 10),
      open: b.open, high: b.high, low: b.low, close: b.close,
      volume: b.volume, amount: b.amount,
    }));
  });
}

module.exports = { name: 'tdx', available, unavailableReason, getIntradayRange, getDayKline, get5minKline, TDX_MAX_PAGES, TDX_MAX_DAYS, TDX_STEP, ROWS_PER_DAY };
