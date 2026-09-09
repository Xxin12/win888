'use strict';
/**
 * 日内做T分析模块（需求文档：量化系统_日内做T分析_需求文档.md）
 *
 * 复用：indicators.js(MA/MACD/KDJ/BOLL) · marketStore.js(日K/5分/分时) · globalStore.js(自选/持仓) · wecom.js(企微)
 *
 * 五大分析维度：
 *  1) 日振幅分析（日K，5年）：最大/平均/中位数/分位/标准差 + 近20日vs5年趋势 + 星期效应 + 沪深300对照
 *  2) 分时形态自动聚类：归一化特征向量 + KMeans，产出原型/频率/图鉴 + 盘中实时概率匹配
 *  3) 双框架 MACD/均线：日K 框架(趋势背景) + 分时框架(当日信号)
 *  4) 分时顶底判定：zigzag拐点 + 价格与均价线乖离 + MACD背离 + 成交量增强 + 置信度分级
 *  5) 多股票对比 / 回测验证 / 每日参考卡 / 阈值可配置 / 企微实时信号
 */

const ms = require('./marketStore');
const gstore = require('./globalStore');
const indicators = require('./indicators');
const intraday = require('./intradayRecorder');
const wecom = require('./wecom');
let getMeta, setMeta;
try { ({ getMeta, setMeta } = require('./db')); } catch (_) { /* db 元信息不可用时退化为内存默认 */ }

// ----------------------------- 基础工具 -----------------------------
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function std(a) { if (!a.length) return 0; const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); }
function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = (s.length - 1) * p / 100;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}
function confidenceRank(c) { return c === 'high' ? 2 : c === 'medium' ? 1 : 0; }
// 确定性随机（聚类初始化可复现）
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function dist2(a, b) { let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; } return s; }

// ----------------------------- 阈值配置 -----------------------------
const DEFAULT_THRESHOLDS = {
  revPct: 0.8,            // zigzag 反转阈值(%)
  devThresh: 1.5,         // 价格与均价线乖离阈值(%) -> 顶/底主因A
  minBars: 3,             // 拐点最小持续根数
  clusterK: 6,            // 形态聚类簇数
  featureLen: 48,         // 分时特征向量长度
  ampRangeLowPct: 25,     // 预期振幅区间下分位
  ampRangeHighPct: 75,    // 预期振幅区间上分位
  notifyMinConfidence: 'low', // 企微推送最低置信度(默认 low=所有置信度都发, 不做数量限制)
  recentDays: 20,         // 趋势/支撑阻力窗口
};
function getThresholds() {
  let stored = {};
  try {
    const m = getMeta && getMeta('dot_thresholds');
    if (m) stored = typeof m === 'string' ? JSON.parse(m) : m;
  } catch (_) { /* ignore */ }
  return Object.assign({}, DEFAULT_THRESHOLDS, stored);
}
function saveThresholds(o) {
  const next = Object.assign({}, getThresholds(), o || {});
  try { setMeta && setMeta('dot_thresholds', JSON.stringify(next)); } catch (_) { /* ignore */ }
  return next;
}

// ----------------------------- 1) 日振幅分析 -----------------------------
function analyzeAmplitude(code, th) {
  const bars = ms.getDayBars(code);
  if (!bars || bars.length < 2) return { ok: false, reason: '日K数据不足' };
  const N = Math.min(bars.length, 5 * 244);
  const recent = bars.slice(-N);
  const amps = [];
  const byWeekday = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  for (let i = 1; i < recent.length; i++) {
    const prev = recent[i - 1].close;
    const amp = (recent[i].high - recent[i].low) / prev * 100;
    amps.push(amp);
    const w = new Date(recent[i].date + 'T00:00:00Z').getUTCDay();
    if (byWeekday[w]) byWeekday[w].push(amp);
  }
  if (!amps.length) return { ok: false, reason: '无振幅数据' };
  // 大盘对照（沪深300 sh000001）
  let benchMean = null;
  try {
    const ib = ms.getDayBars('sh000001');
    if (ib && ib.length > 1) {
      const ir = ib.slice(-N); const iamps = [];
      for (let i = 1; i < ir.length; i++) iamps.push((ir[i].high - ir[i].low) / ir[i - 1].close * 100);
      if (iamps.length) benchMean = mean(iamps);
    }
  } catch (_) { /* ignore */ }
  const recent20 = amps.slice(-th.recentDays);
  const overallMean = mean(amps);
  const r20 = mean(recent20);
  const weekday = {};
  for (const k of [1, 2, 3, 4, 5]) weekday[k] = { mean: byWeekday[k].length ? +mean(byWeekday[k]).toFixed(2) : null, n: byWeekday[k].length };
  return {
    ok: true, n: amps.length,
    max: +Math.max(...amps).toFixed(2),
    avg: +overallMean.toFixed(2),
    median: +percentile(amps, 50).toFixed(2),
    p10: +percentile(amps, 10).toFixed(2),
    p25: +percentile(amps, 25).toFixed(2),
    p75: +percentile(amps, 75).toFixed(2),
    p90: +percentile(amps, 90).toFixed(2),
    std: +std(amps).toFixed(2),
    recent20Mean: +r20.toFixed(2),
    overallMean: +overallMean.toFixed(2),
    trend: +(r20 - overallMean).toFixed(2),
    weekday,
    benchmarkMean: benchMean != null ? +benchMean.toFixed(2) : null,
    benchmarkRatio: benchMean ? +(overallMean / benchMean).toFixed(2) : null,
    rangeLow: +percentile(amps, th.ampRangeLowPct).toFixed(2),
    rangeHigh: +percentile(amps, th.ampRangeHighPct).toFixed(2),
    amps, // 直方图用原始序列
  };
}

// ----------------------------- 2) 分时形态聚类 -----------------------------
// 把一天的分时价序列归一化为「相对开盘价的百分比」，重采样到固定长度 L
function buildFeature(rows, L) {
  if (!rows || rows.length < 2) return null;
  const base = rows[0].price || 1;
  const prices = rows.map((r) => (r.price / base - 1) * 100);
  const n = prices.length;
  if (n === 1) return new Array(L).fill(0);
  const out = new Array(L);
  for (let i = 0; i < L; i++) {
    const pos = (i / (L - 1)) * (n - 1);
    const i0 = Math.floor(pos), i1 = Math.min(n - 1, i0 + 1), f = pos - i0;
    out[i] = prices[i0] * (1 - f) + prices[i1] * f;
  }
  return out;
}
// 由簇质心生成可读名称（方向·波动）
function patternName(centroid) {
  const end = centroid[centroid.length - 1];
  const m = mean(centroid);
  const vol = Math.sqrt(centroid.reduce((a, b) => a + (b - m) ** 2, 0) / centroid.length);
  const dir = end > 1.2 ? '强上行' : end > 0.2 ? '上行' : end < -1.2 ? '强下行' : end < -0.2 ? '下行' : '横盘';
  const v = vol > 1.2 ? '高波动' : vol > 0.6 ? '中波动' : '低波动';
  return `${dir}·${v}`;
}
function kmeans(points, k, iters, seed) {
  const n = points.length;
  if (n === 0) return { centroids: [], assign: [] };
  const kk = Math.min(k, n);
  const rnd = mulberry32(seed || 7);
  const centroids = [points[Math.floor(rnd() * n)].slice()];
  while (centroids.length < kk) {
    const dists = points.map((p) => Math.min(...centroids.map((c) => dist2(p, c))));
    const sum = dists.reduce((a, b) => a + b, 0) || 1;
    let r = rnd() * sum, idx = 0;
    for (let i = 0; i < n; i++) { r -= dists[i]; if (r <= 0) { idx = i; break; } }
    centroids.push(points[idx].slice());
  }
  const assign = new Array(n).fill(0);
  for (let it = 0; it < iters; it++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < kk; c++) { const d = dist2(points[i], centroids[c]); if (d < bd) { bd = d; best = c; } }
      if (assign[i] !== best) { assign[i] = best; changed = true; }
    }
    const sums = Array.from({ length: kk }, () => new Array(points[0].length).fill(0));
    const cnt = new Array(kk).fill(0);
    for (let i = 0; i < n; i++) { cnt[assign[i]]++; const p = points[i]; for (let j = 0; j < p.length; j++) sums[assign[i]][j] += p[j]; }
    for (let c = 0; c < kk; c++) { if (!cnt[c]) continue; for (let j = 0; j < centroids[c].length; j++) centroids[c][j] = sums[c][j] / cnt[c]; }
    if (!changed && it > 0) break;
  }
  return { centroids, assign };
}
function analyzePatterns(code, th) {
  const dates = ms.listIntradayDates(code);
  if (!dates || !dates.length) return { ok: false, reason: '分时数据不足' };
  const meta = [];
  for (const d of dates) {
    const rec = ms.getIntraday(code, d);
    if (!rec || !rec.rows || rec.rows.length < 10) continue;
    const v = buildFeature(rec.rows, th.featureLen);
    if (!v) continue;
    meta.push({ date: d, rows: rec.rows, vec: v });
  }
  if (meta.length < Math.max(th.clusterK, 2)) return { ok: false, reason: `有效分时天数不足(${meta.length})，需≥${th.clusterK}` };
  const { centroids, assign } = kmeans(meta.map((m) => m.vec), th.clusterK, 30, 7);
  const clusters = [];
  for (let c = 0; c < centroids.length; c++) {
    const members = meta.filter((_, i) => assign[i] === c);
    let bestI = -1, bd = Infinity;
    members.forEach((m, i) => { const dd = dist2(m.vec, centroids[c]); if (dd < bd) { bd = dd; bestI = i; } });
    const rep = bestI >= 0 ? members[bestI] : members[0];
    clusters.push({
      id: c, name: patternName(centroids[c]),
      centroid: centroids[c].map((x) => +x.toFixed(3)),
      freq: members.length,
      freqPct: +(members.length / meta.length * 100).toFixed(1),
      exampleDate: rep.date,
      endPct: +centroids[c][centroids[c].length - 1].toFixed(2),
    });
  }
  clusters.sort((a, b) => b.freq - a.freq);
  const assignments = {};
  meta.forEach((m, i) => { assignments[m.date] = assign[i]; });
  return { ok: true, n: meta.length, clusters, assignments };
}
// 盘中实时概率匹配：给定一天的分时行，返回与各形态原型的距离概率
function matchPattern(rows, clusters, th) {
  if (!rows || !clusters || !clusters.length) return { best: null, bestName: null, bestProb: 0, probs: [] };
  const v = buildFeature(rows, th.featureLen);
  if (!v) return { best: null, bestName: null, bestProb: 0, probs: [] };
  const sim = clusters.map((c) => 1 / (1 + Math.sqrt(dist2(v, c.centroid))));
  const sum = sim.reduce((a, b) => a + b, 0) || 1;
  const probs = clusters.map((c, i) => ({ id: c.id, name: c.name, prob: +(sim[i] / sum).toFixed(4) }));
  let bi = 0; for (let i = 1; i < sim.length; i++) if (sim[i] > sim[bi]) bi = i;
  return { best: clusters[bi].id, bestName: clusters[bi].name, bestProb: probs[bi].prob, probs };
}

// 形态聚类结果按 (code + 最后分时日期 + 阈值) 缓存，避免每次页面刷新重算
const _patCache = new Map();
function cachedPatterns(code, th) {
  const dates = ms.listIntradayDates(code);
  const lastDate = dates && dates[0] ? dates[0] : '';
  const key = code + '|' + lastDate + '|' + JSON.stringify(th);
  if (_patCache.has(key)) return _patCache.get(key);
  const r = analyzePatterns(code, th);
  _patCache.set(key, r);
  if (_patCache.size > 50) _patCache.delete(_patCache.keys().next().value);
  return r;
}

// ----------------------------- 4) 分时顶底判定 -----------------------------
// zigzag：价格反向 >= revPct 即确认一个拐点（交替 top/bottom）
function zigzag(P, revPct) {
  const pivots = [];
  if (P.length < 2) return pivots;
  let dir = P[1] >= P[0] ? 1 : -1;
  let extIdx = 0, extP = P[0];
  for (let i = 1; i < P.length; i++) {
    if (dir === 1) {
      if (P[i] > extP) { extP = P[i]; extIdx = i; }
      else if ((extP - P[i]) / extP * 100 >= revPct) { pivots.push({ index: extIdx, price: extP, type: 'top' }); dir = -1; extP = P[i]; extIdx = i; }
    } else {
      if (P[i] < extP) { extP = P[i]; extIdx = i; }
      else if ((P[i] - extP) / extP * 100 >= revPct) { pivots.push({ index: extIdx, price: extP, type: 'bottom' }); dir = 1; extP = P[i]; extIdx = i; }
    }
  }
  pivots.push({ index: extIdx, price: extP, type: dir === 1 ? 'top' : 'bottom' });
  return pivots;
}
// MACD 背离：top 价格新高但 dif 未新高 -> 顶背离(bearish)；bottom 价格新低但 dif 未新低 -> 底背离(bullish)
function checkDivergence(type, s, i, P, dif) {
  const priceHigher = P[i] > P[s];
  const difHigher = (dif[i] || 0) > (dif[s] || 0);
  if (type === 'top') return (priceHigher && !difHigher) ? 'bearish' : null;
  return (!priceHigher && difHigher) ? 'bullish' : null;
}
function detectTopsBottoms(rows, th) {
  th = th || {};
  const revPct = th.revPct != null ? th.revPct : 0.8;
  const devThresh = th.devThresh != null ? th.devThresh : 1.5;
  const minBars = th.minBars != null ? th.minBars : 3;
  if (!rows || rows.length < minBars + 2) return [];
  const P = rows.map((r) => r.price);
  // 中枢：优先用均价线 avg，缺失回退价格本身
  const avg = rows.map((r) => (r.avg != null && isFinite(r.avg) && r.avg > 0) ? r.avg : r.price);
  const macd = indicators.MACD(P);
  const dif = macd.dif;
  const dev = P.map((p, i) => (avg[i] ? (p - avg[i]) / avg[i] * 100 : 0));
  const meanVol = mean(rows.map((r) => r.volume || 0)) || 1;
  const pivots = zigzag(P, revPct);
  const out = [];
  let prev = null;
  for (let k = 0; k < pivots.length; k++) {
    const pv = pivots[k];
    const s = prev ? prev.index : 0;
    const div = checkDivergence(pv.type, s, pv.index, P, dif);
    const d = dev[pv.index];
    const volRatio = (rows[pv.index].volume || 0) / meanVol;
    const extreme = Math.abs(d) > devThresh;
    let conf = 'low';
    if (extreme && div) conf = 'high';
    else if (extreme) conf = 'medium';
    else if (div) conf = 'low';
    out.push({
      index: pv.index, time: rows[pv.index].t, price: +pv.price.toFixed(2),
      type: pv.type, dev: +d.toFixed(2), divergence: div, volRatio: +volRatio.toFixed(2), confidence: conf,
    });
    prev = pv;
  }
  return out;
}

// ----------------------------- 3) 双框架 MACD/均线 -----------------------------
function analyzeIndicators(code) {
  const bars = ms.getDayBars(code);
  const ind = { daily: null, hasDaily: false };
  if (bars && bars.length) {
    const daily = indicators.computeAll(bars, ['MA', 'MACD', 'KDJ', 'BOLL']);
    const last = (i) => (Array.isArray(i) ? i[i.length - 1] : null);
    ind.daily = {
      ma: { MA5: last(daily.MA.MA5), MA10: last(daily.MA.MA10), MA20: last(daily.MA.MA20), MA60: last(daily.MA.MA60) },
      macd: { dif: last(daily.MACD.dif), dea: last(daily.MACD.dea), macd: last(daily.MACD.macd) },
      lastClose: bars[bars.length - 1].close,
    };
    ind.hasDaily = true;
  }
  return ind;
}

// ----------------------------- 每日参考卡 -----------------------------
function buildReference(code, th, amp, ind) {
  const ref = { rule: `分时价格与均价线乖离≥${th.devThresh}% 且 MACD 出现背离时为高置信顶/底信号` };
  if (amp && amp.ok) {
    ref.expectedRange = { low: amp.rangeLow, high: amp.rangeHigh, unit: '%' };
    ref.amplitudeAvg = amp.avg;
    ref.amplitudeMax = amp.max;
  }
  if (ind && ind.daily) {
    ref.ma = ind.daily.ma;
    ref.macd = ind.daily.macd;
    ref.lastClose = ind.daily.lastClose;
  }
  const bars = ms.getDayBars(code);
  if (bars && bars.length) {
    const r = bars.slice(-th.recentDays);
    ref.recentHigh = +Math.max.apply(null, r.map((b) => b.high)).toFixed(2);
    ref.recentLow = +Math.min.apply(null, r.map((b) => b.low)).toFixed(2);
    ref.lastClose = r[r.length - 1].close;
  }
  // 可选持仓成本线
  try {
    const pf = gstore.getPortfolio();
    const hit = pf.find((x) => x.code === code || String(x.code).replace(/^(sh|sz|bj)/, '') === code.replace(/^(sh|sz|bj)/, ''));
    if (hit && hit.cost) ref.cost = hit.cost;
  } catch (_) { /* ignore */ }
  return ref;
}

// ----------------------------- 单日分析（顶底 + 形态匹配 + 分时MACD） -----------------------------
function analyzeDay(code, date, th) {
  const rec = ms.getIntraday(code, date);
  if (!rec || !rec.rows || !rec.rows.length) return { ok: false, reason: '该日分时无数据' };
  const rows = rec.rows;
  const tb = detectTopsBottoms(rows, th);
  const P = rows.map((r) => r.price);
  const macd = indicators.MACD(P);
  const last = (i) => (i && i.length ? i[i.length - 1] : null);
  const intradayMacd = { dif: last(macd.dif), dea: last(macd.dea), macd: last(macd.macd) };
  const pat = cachedPatterns(code, th);
  let match = null;
  if (pat.ok) {
    const v = buildFeature(rows, th.featureLen);
    if (v) match = matchPattern(rows, pat.clusters, th);
  }
  return { ok: true, date, count: rows.length, topsBottoms: tb, intradayMacd, patternMatch: match };
}

// ----------------------------- 5) 多股票对比 -----------------------------
function compareStocks(codes, th) {
  const rows = [];
  for (const code of (codes || [])) {
    const rec = { code };
    const amp = analyzeAmplitude(code, th);
    if (amp.ok) { rec.ampAvg = amp.avg; rec.ampP75 = amp.p75; rec.ampMax = amp.max; rec.benchRatio = amp.benchmarkRatio; rec.nDays = amp.n; }
    else rec.error = amp.reason;
    const pat = analyzePatterns(code, th);
    if (pat.ok) { rec.patternCount = pat.n; rec.dominant = pat.clusters[0] ? pat.clusters[0].name : null; rec.dominantPct = pat.clusters[0] ? pat.clusters[0].freqPct : null; }
    // 顶底密度（近 60 个有数据日）
    const dates = (ms.listIntradayDates(code) || []).slice(0, 60);
    let tb = 0;
    for (const d of dates) { const ir = ms.getIntraday(code, d); if (ir && ir.rows) tb += detectTopsBottoms(ir.rows, th).length; }
    rec.tbDensity = dates.length ? +(tb / dates.length).toFixed(2) : null;
    rows.push(rec);
  }
  return { ok: true, rows };
}

// ----------------------------- 回测验证（顶/底+背离 信号做T） -----------------------------
function backtest(code, th) {
  const dates = ms.listIntradayDates(code);
  if (!dates || !dates.length) return { ok: false, reason: '分时数据不足' };
  let trades = 0, wins = 0, sumRet = 0, daysWith = 0;
  for (const d of dates) {
    const rec = ms.getIntraday(code, d);
    if (!rec || !rec.rows) continue;
    const all = detectTopsBottoms(rec.rows, th); // 全量拐点（交替 top/bottom）
    if (!all.some((s) => s.confidence !== 'low')) continue; // 当日无显著锚点
    daysWith++;
    // 用全量序列配对（保留交替结构），仅统计含显著锚点的交易对
    const sorted = all.slice().sort((a, b) => a.index - b.index);
    let buy = null;
    for (const s of sorted) {
      if (s.type === 'bottom' && buy === null) buy = s;
      else if (s.type === 'top' && buy !== null) {
        if (buy.confidence !== 'low' || s.confidence !== 'low') {
          const ret = (s.price - buy.price) / buy.price * 100;
          trades++; sumRet += ret; if (ret > 0) wins++;
        }
        buy = null;
      }
    }
  }
  return {
    ok: true, days: dates.length, daysWithSignals: daysWith,
    trades, winRate: trades ? +(wins / trades * 100).toFixed(1) : 0,
    avgRet: trades ? +(sumRet / trades).toFixed(3) : 0,
    totalRet: +sumRet.toFixed(2),
  };
}

// ----------------------------- 分时回放（验证盘中信号 vs 盘后复盘） -----------------------------
// 返回原始分时行 + 盘后复盘(全量)顶底信号，并为每个信号计算 `discoveredAt`：
//   在「仅看到前 n 根」的部分数据上重新跑检测，该拐点最早在哪一刻被算法确认为顶/底。
// 由此可在回放时对比「盘中实时发出的信号」与「盘后复盘信号」是否能匹配：
//   - 已提交信号 = 盘中发出且确实存在于盘后复盘者（discoveredAt<=n 且最终存在）→ 全天结束时与盘后完全一致。
//   - 待确认(未定型) = 盘尾运行中的极值（尚未被反转确认，可能随后续新高/新低平移）→ 实时算法的诚实行为。
function getReplay(code, date, th, withPattern) {
  const rec = ms.getIntraday(code, date);
  if (!rec || !rec.rows || !rec.rows.length) return { ok: false, reason: '该日分时无数据' };
  const rows = rec.rows.map((r) => ({ t: r.t, price: r.price, avg: r.avg, volume: r.volume, cumVolume: r.cumVolume }));
  const N = rows.length;
  const full = detectTopsBottoms(rows, th);
  const signals = full.map((s) => {
    let discoveredAt = N; // 兜底：全量时必然已确认
    for (let n = s.index + 1; n <= N; n++) {
      const part = detectTopsBottoms(rows.slice(0, n), th);
      if (part.some((p) => p.type === s.type && p.index === s.index)) { discoveredAt = n; break; }
    }
    return { ...s, discoveredAt };
  });
  const out = { ok: true, date, count: N, rows, signals };
  // 昨收(振幅百分比基准)：优先用【上一交易日的原始分时末价】(分时=未复权/raw, 与当日分时同尺度),
  // 避免本地日K【前复权】存储(除权除息使历史价下调)导致的尺度错配/振幅虚高。无分时落盘时兜底用日K收盘(前复权)。
  try {
    const dates = ms.listIntradayDates(code); // 降序
    let prev = null;
    for (const d of dates) { if (d < date) { prev = d; break; } }
    if (prev) {
      const prec = ms.getIntraday(code, prev);
      if (prec && prec.rows && prec.rows.length) out.prevClose = +prec.rows[prec.rows.length - 1].price.toFixed(2);
    }
    if (out.prevClose == null) {
      const bars = ms.getDayBars(code);
      if (bars && bars.length) {
        let idx = -1;
        for (let i = 0; i < bars.length; i++) { if (bars[i].date === date) { idx = i; break; } }
        if (idx > 0) out.prevClose = +bars[idx - 1].close.toFixed(2);
        else if (idx === 0 && bars[0]) out.prevClose = +bars[0].open.toFixed(2);
      }
    }
  } catch (_) { /* ignore */ }
  // 回放同时进行盘中实时形态概率匹配：逐根切片匹配历史簇原型
  if (withPattern) {
    const pat = cachedPatterns(code, th);
    if (pat.ok) {
      out.patterns = pat.clusters.map((c) => ({ id: c.id, name: c.name, freqPct: c.freqPct }));
      const probs = [];
      for (let n = 1; n <= N; n++) {
        const mp = matchPattern(rows.slice(0, n), pat.clusters, th);
        probs.push({ bestName: mp.bestName, bestProb: mp.bestProb, probs: mp.probs });
      }
      out.patternProbs = probs; // 长度 N，probs[i] = 第 i+1 根时的形态概率分布
    }
  }
  return out;
}

// ----------------------------- 综合入口 -----------------------------
function analyze(code) {
  const th = getThresholds();
  const amp = analyzeAmplitude(code, th);
  const ind = analyzeIndicators(code);
  const pat = cachedPatterns(code, th);
  const ref = buildReference(code, th, amp.ok ? amp : null, ind);
  let todayPattern = null;
  try {
    const today = intraday.todayStr();
    const rec = ms.getIntraday(code, today);
    if (rec && rec.rows && rec.rows.length && pat.ok) {
      const v = buildFeature(rec.rows, th.featureLen);
      if (v) todayPattern = matchPattern(rec.rows, pat.clusters, th);
    }
  } catch (_) { /* ignore */ }
  let coverage = null;
  try {
    const c = gstore.getCoverageMap([code]).get(code);
    coverage = c ? { hasDay: !!c.hasDay, hasIntraday: !!c.intradayDates, intradayDates: c.intradayDates } : { hasDay: false, hasIntraday: false, intradayDates: 0 };
  } catch (_) { coverage = null; }
  return {
    ok: true, code, thresholds: th, coverage,
    amplitude: amp.ok ? amp : { ok: false, reason: amp.reason },
    indicators: ind, patterns: pat, reference: ref, todayPattern,
  };
}

// ----------------------------- 企微实时信号 -----------------------------
async function notifyToday(code, th) {
  th = th || getThresholds();
  const today = intraday.todayStr();
  const rec = ms.getIntraday(code, today);
  if (!rec || !rec.rows) return { ok: false, reason: '今日分时未就绪' };
  // 最低置信度取「企微配置」(与自动推送统一), 而非 dot_thresholds
  const minConf = (wecom.readConfig().notifyMinConfidence) || 'high';
  const sigs = detectTopsBottoms(rec.rows, th).filter((s) => confidenceRank(s.confidence) >= confidenceRank(minConf));
  const name = (gstore.getWatchlist().find((x) => x.code === code) || {}).name || code;
  const pushed = [];
  for (const s of sigs) {
    try {
      const r = await wecom.sendNotify({
        type: s.type, code, name,
        price: s.price,
        avg: (rec.rows[s.index].avg != null ? rec.rows[s.index].avg : s.price),
        time: s.time,
        confidence: s.confidence, dev: s.dev, divergence: s.divergence, volRatio: s.volRatio,
        dedup: false, // 手动主动发送, 不被服务端去重拦截
      });
      pushed.push({ type: s.type, time: s.time, price: s.price, ok: r.ok });
    } catch (e) { pushed.push({ type: s.type, time: s.time, price: s.price, ok: false, error: e.message }); }
  }
  return { ok: true, pushed: pushed.length, signals: pushed };
}

// 实时扫描（纯文字兜底）：交易时段每 3 分钟对自选股扫描「今日分时」顶/底。
// 角色：页面关闭时仍发顶/底文字通知（不带截图），避免漏信号；带截图的主路径由前端负责。
// 差值发送(替代去重)：模块级 _prevSigs 记录上一轮每只股票的信号键集合，每轮仅发「新出现」的拐点，
// 避免同一已存在拐点被全天重复轰炸；数量不做限制(每轮出现多少新信号发多少)。不做持久化去重。
const _prevSigs = new Map(); // code -> Set(sigKey)
function startLiveScanner() {
  const tick = () => {
    if (!intraday.isTradingNow()) return;
    const th = getThresholds();
    const cfg = wecom.readConfig();
    if (!cfg || !cfg.enabled) return; // 企微未开启则不推送
    // 自动推送最低置信度(与企微配置/前端一致)
    const minConf = cfg.notifyMinConfidence || 'high';
    const minRank = confidenceRank(minConf);
    const codes = gstore.getWatchlist().map((x) => x.code);
    const watchNames = gstore.getWatchlist();
    for (const code of codes) {
      try {
        const today = intraday.todayStr();
        const rec = ms.getIntraday(code, today);
        if (!rec || !rec.rows) continue;
        const sigs = detectTopsBottoms(rec.rows, th).filter((s) => confidenceRank(s.confidence) >= minRank);
        const name = (watchNames.find((x) => x.code === code) || {}).name || code;
        const prevSet = _prevSigs.get(code) || new Set();
        const nowSet = new Set();
        for (const s of sigs) {
          const sigKey = code + '|' + today + '|' + s.type + '|' + s.time;
          nowSet.add(sigKey);
          if (prevSet.has(sigKey)) continue; // 非本轮新增 → 跳过(差值发送, 非持久去重)
          wecom.sendNotify({
            type: s.type, code, name, price: s.price,
            avg: (rec.rows[s.index] && rec.rows[s.index].avg != null) ? rec.rows[s.index].avg : s.price,
            time: s.time,
            confidence: s.confidence, dev: s.dev, divergence: s.divergence, volRatio: s.volRatio,
          }).catch(() => {});
        }
        _prevSigs.set(code, nowSet);
      } catch (_) { /* 单只异常不影响其他 */ }
    }
  };
  setInterval(tick, 180000);
  setInterval(() => { _prevSigs.clear(); }, 24 * 3600 * 1000); // 每日清零(新交易日重新计数)
}

module.exports = {
  analyze, analyzeDay, analyzeAmplitude, analyzePatterns, detectTopsBottoms,
  analyzeIndicators, buildReference, compareStocks, backtest,
  getThresholds, saveThresholds, notifyToday, startLiveScanner,
  matchPattern, cachedPatterns, getReplay,
};
