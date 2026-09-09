'use strict';
// 定投策略回测引擎 (DCA - Dollar Cost Averaging)
// 需求文档: 量化系统_定投策略回测_需求文档.md
// 数据来源: p.bars (前端手动导入的日线) 优先; 缺省回退本地 SQLite getDayBars(code)
const ms = require('../lib/marketStore');

// ---------- 基础工具 ----------

// 日期归一: 2004/08/04 | 20040804 | 2004-8-4 -> 2004-08-04
function normDate(v) {
  if (v == null) return '';
  let s = String(v).trim().replace(/[\/.]/g, '-');
  if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return '';
  return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
}

// 数值归一: 支持 "+5.34%" / "-4.98%" / "--" / "" / 千分位
function num(v) {
  if (v == null || v === '') return NaN;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[,%\s+]/g, '');
  if (!s || s === '--' || s === '-') return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function r2(v) { return Math.round(v * 100) / 100; }
function r4(v) { return Math.round(v * 10000) / 10000; }

/**
 * 清洗日线序列
 * 处理: 日期归一 / 数值归一 / 升序 / 去重 / 剔除非法价格 / 截断前复权负价格区间
 * @returns {{bars:Array, skipped:number, warnings:string[], rawRows:number}}
 */
function cleanBars(raw, priceType) {
  const warnings = [];
  const isRaw = priceType === 'raw'; // 除权(原始)数据: 价格全为正, 不做"前复权负价截断", 不报复权异常
  const rawRows = Array.isArray(raw) ? raw.length : 0;
  if (!rawRows) return { bars: [], skipped: 0, warnings: ['输入数据为空'], rawRows: 0 };

  const map = new Map();
  let badRow = 0, fixedHL = 0;
  for (const r of raw) {
    const date = normDate(r.date != null ? r.date : r.time);
    if (!date) { badRow++; continue; }
    const close = num(r.close);
    // 价格必须为正: 剔除 0/负/缺失。除权原始数据早期可能出现负数占位(如 -1.22), 前复权序列则在 0 附近平移
    if (!Number.isFinite(close) || close <= 0) { badRow++; continue; }
    let open = num(r.open);
    if (!Number.isFinite(open) || open <= 0) open = close;
    let high = num(r.high); let low = num(r.low);
    // 前复权早期(价格贴近0)常出现最高/最低为负 —— 不丢弃整行, 用开/收价修正
    const hiBad = !Number.isFinite(high) || high <= 0;
    const loBad = !Number.isFinite(low) || low <= 0;
    if (hiBad) high = Math.max(open, close);
    if (loBad) low = Math.min(open, close);
    if ((hiBad || loBad) && open > 0 && close > 0) fixedHL++;
    // 修正越界的最高/最低(部分导出源存在此问题)
    if (high < Math.max(open, close)) high = Math.max(open, close);
    if (low > Math.min(open, close)) low = Math.min(open, close);
    const volume = num(r.volume); const amount = num(r.amount);
    map.set(date, {
      date, open, high, low, close,
      volume: Number.isFinite(volume) ? volume : 0,
      amount: Number.isFinite(amount) ? amount : 0,
    });
  }
  if (badRow) warnings.push('已忽略 ' + badRow + ' 行无法解析的记录');

  let all = Array.from(map.values()).sort((a, b) => (a.date < b.date ? -1 : 1));

  let bars = all;
  let headSkipped = 0;
  if (!isRaw) {
    // 前复权早期负价格: 借壳上市股(如 002027 借壳七喜控股)的前复权序列会在零点反复穿越,
    // 因此必须从"最后一个非正价格之后"截断, 才能得到连续全正的有效区间。
    let lastBad = -1;
    for (let i = 0; i < all.length; i++) if (!(all[i].open > 0 && all[i].close > 0)) lastBad = i;
    const start = lastBad + 1;
    headSkipped = start;
    if (headSkipped) {
      warnings.push('已跳过前 ' + headSkipped + ' 行非正价格数据（前复权早期区间，最后一个异常日 ' +
        all[lastBad].date + '），有效区间自 ' + (all[start] ? all[start].date : '-') + ' 起');
    }
    bars = all.slice(start);
  }
  if (fixedHL) warnings.push('已修正 ' + fixedHL + ' 行非正的最高/最低价（' + (isRaw ? '除权原始数据' : '前复权早期特征') + '，不影响定投成交价）');

  // 复权异常检测: 借壳/巨额送转会让早期前复权价趋近于 0, 导致回测收益率严重虚高(仅前复权口径)
  if (!isRaw && bars.length > 1) {
    let lo = Infinity, hi = 0;
    for (const b of bars) { if (b.close < lo) lo = b.close; if (b.close > hi) hi = b.close; }
    if (lo > 0 && hi / lo > 20) {
      warnings.push('⚠️ 复权异常提示：有效区间内最高收盘价是最低价的 ' + Math.round(hi / lo) +
        ' 倍（最低 ' + lo + ' 元）。常见于借壳上市或巨额送转股的前复权序列，早期价格已被压缩到接近 0，' +
        '若从最早日期开始定投，收益率会严重虚高。建议将回测起始日设在近 5~10 年内。');
    }
  }
  if (isRaw) {
    warnings.push('ℹ️ 已按「除权(原始)」数据处理：历史除权日价格跳空为真实除权，定投收益未含现金红利及其再投资，长期收益会略低于含权口径。');
  }

  // 日期空洞提示
  for (let i = 1; i < bars.length; i++) {
    const gap = (Date.parse(bars[i].date) - Date.parse(bars[i - 1].date)) / 86400000;
    if (gap > 30) {
      warnings.push('数据存在空洞: ' + bars[i - 1].date + ' → ' + bars[i].date + '（' + Math.round(gap) + ' 天）');
      break;
    }
  }

  return { bars, skipped: headSkipped + badRow, warnings, rawRows };
}

// ---------- 定投日调度 ----------

// 生成"计划日历日"序列(不含交易日概念), 后续统一顺延到首个可交易日
function planDates(firstDate, lastDate, freq, dayOfWeek, dayOfMonth) {
  const out = [];
  const d0 = new Date(firstDate + 'T00:00:00');
  const dEnd = new Date(lastDate + 'T00:00:00');
  const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

  if (freq === 'weekly' || freq === 'biweekly') {
    const step = freq === 'weekly' ? 7 : 14;
    const target = Math.min(5, Math.max(1, Number(dayOfWeek) || 1));
    const cur = new Date(d0);
    // 对齐到起始周的目标星期
    const shift = (target - (cur.getDay() === 0 ? 7 : cur.getDay()) + 7) % 7;
    cur.setDate(cur.getDate() + shift);
    while (cur <= dEnd) { out.push(iso(cur)); cur.setDate(cur.getDate() + step); }
    return out;
  }

  // monthly
  const target = Math.min(28, Math.max(1, Number(dayOfMonth) || 1));
  const cur = new Date(d0.getFullYear(), d0.getMonth(), target);
  while (cur <= dEnd) {
    if (cur >= d0) out.push(iso(cur));
    cur.setMonth(cur.getMonth() + 1);
    cur.setDate(target);
  }
  return out;
}

/**
 * 构建定投日索引集合
 * daily/custom 按交易日索引推进; weekly/biweekly/monthly 按日历日顺延到首个可交易日
 */
function buildSchedule(bars, p) {
  const set = new Set();
  if (!bars.length) return set;
  const freq = p.freq || 'monthly';

  if (freq === 'daily') { for (let i = 0; i < bars.length; i++) set.add(i); return set; }
  if (freq === 'custom') {
    const n = Math.max(1, Number(p.everyNDays) || 20);
    for (let i = 0; i < bars.length; i += n) set.add(i);
    return set;
  }

  const targets = planDates(bars[0].date, bars[bars.length - 1].date, freq, p.dayOfWeek, p.dayOfMonth);
  let j = 0;
  for (const td of targets) {
    while (j < bars.length && bars[j].date < td) j++;
    if (j >= bars.length) break;
    set.add(j); // 顺延: 首个 >= 计划日的交易日
  }
  return set;
}

// ---------- 加码倍率 ----------

const DEFAULT_TIERS = [
  { dev: -30, mul: 2.0 }, { dev: -15, mul: 1.5 }, { dev: 15, mul: 1.0 },
  { dev: 30, mul: 0.7 }, { dev: Infinity, mul: 0.5 },
];

// 预计算收盘均线(简单移动平均, 不足周期用已有根数)
function calcMA(bars, period) {
  const out = new Array(bars.length);
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= period) sum -= bars[i - period].close;
    out[i] = sum / Math.min(i + 1, period);
  }
  return out;
}

function pickMul(dev, tiers) {
  for (const t of tiers) if (dev <= t.dev / 100) return t.mul;
  return tiers.length ? tiers[tiers.length - 1].mul : 1;
}

// ---------- XIRR ----------

function makeNpv(flows) {
  const base = Date.parse(flows[0].date);
  const yrs = flows.map((f) => (Date.parse(f.date) - base) / 86400000 / 365);
  const amts = flows.map((f) => f.amount);
  return {
    npv: (r) => { let s = 0; for (let i = 0; i < amts.length; i++) s += amts[i] / Math.pow(1 + r, yrs[i]); return s; },
    dnpv: (r) => { let s = 0; for (let i = 0; i < amts.length; i++) s += -yrs[i] * amts[i] / Math.pow(1 + r, yrs[i] + 1); return s; },
  };
}

// 完整版: 牛顿迭代 + 二分兜底, 返回小数年化(0.1034 = 10.34%)
function xirr(flows) {
  if (!flows || flows.length < 2) return null;
  const hasNeg = flows.some((f) => f.amount < 0);
  const hasPos = flows.some((f) => f.amount > 0);
  if (!hasNeg || !hasPos) return null;
  const { npv, dnpv } = makeNpv(flows);
  let r = 0.1;
  for (let i = 0; i < 100; i++) {
    const f = npv(r); const fp = dnpv(r);
    if (!Number.isFinite(f) || !Number.isFinite(fp) || Math.abs(fp) < 1e-12) break;
    const nr = r - f / fp;
    if (!Number.isFinite(nr) || nr <= -0.9999 || nr > 100) break;
    if (Math.abs(nr - r) < 1e-7) return nr;
    r = nr;
  }
  let lo = -0.9999, hi = 10, flo = npv(lo);
  if (!Number.isFinite(flo)) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2; const fm = npv(mid);
    if (!Number.isFinite(fm)) return null;
    if ((flo < 0) === (fm < 0)) { lo = mid; flo = fm; } else hi = mid;
    if (hi - lo < 1e-8) break;
  }
  return (lo + hi) / 2;
}

// 快速版(供逐日止盈判定): 仅牛顿20次, 不做二分兜底
function xirrFast(flows) {
  if (!flows || flows.length < 2) return null;
  const { npv, dnpv } = makeNpv(flows);
  let r = 0.1;
  for (let i = 0; i < 20; i++) {
    const f = npv(r); const fp = dnpv(r);
    if (!Number.isFinite(f) || !Number.isFinite(fp) || Math.abs(fp) < 1e-12) return null;
    const nr = r - f / fp;
    if (!Number.isFinite(nr) || nr <= -0.9999 || nr > 100) return null;
    if (Math.abs(nr - r) < 1e-7) return nr;
    r = nr;
  }
  return r;
}

// ---------- 费用 ----------

function makeFeeCalc(p) {
  const commRate = p.commRate != null ? Number(p.commRate) : 0.00025;
  const commMin = p.commMin != null ? Number(p.commMin) : 5;
  const stampRate = p.stampRate != null ? Number(p.stampRate) : 0.0005;
  const transferRate = p.transferRate != null ? Number(p.transferRate) : 0.00001;
  return {
    buy: (gross) => Math.max(gross * commRate, commMin) + gross * transferRate,
    sell: (gross) => Math.max(gross * commRate, commMin) + gross * transferRate + gross * stampRate,
  };
}

function pickPrice(bar, mode) {
  if (mode === 'open') return bar.open;
  if (mode === 'avgHL') return (bar.high + bar.low) / 2;
  return bar.close;
}

// ---------- 主流程 ----------

/**
 * 定投回测
 * @param {object} p {code, bars?, source, params:{...}}
 */
function runDca(p) {
  const code = p.code || '';
  const cfg = Object.assign({
    freq: 'monthly', dayOfWeek: 1, dayOfMonth: 1, everyNDays: 20,
    amount: 5000, priceMode: 'close', lotMode: 'lot100', carryOver: true,
    buyRule: 'fixed', buyMode: 'amount', sharesPerPeriod: 100, priceType: 'qfq',
    dividendReinvest: false,
    start: '', end: '',
    boostMode: 'off', maPeriod: 250, boostTiers: DEFAULT_TIERS, dropPct: 5, dropMul: 2,
    takeMode: 'off', takeValue: 30, afterTake: 'restart',
    commRate: 0.00025, commMin: 5, stampRate: 0.0005, transferRate: 0.00001,
    benchRate: 3,
  }, p.params || {});

  // 1) 取数 + 清洗
  let raw = Array.isArray(p.bars) && p.bars.length ? p.bars : null;
  let source = 'import';
  if (!raw) {
    raw = ms.getDayBars(code) || [];
    source = 'db';
    if (!raw.length) return { ok: false, error: '无日线数据：本地库 ' + code + ' 为空，请手动导入 CSV' };
  }
  const cleaned = cleanBars(raw, cfg.priceType);
  let bars = cleaned.bars;
  if (bars.length < 60) {
    return { ok: false, error: '有效日线不足 60 根（当前 ' + bars.length + ' 根），无法进行定投回测', meta: { warnings: cleaned.warnings } };
  }

  // 2) 区间裁剪
  const fullFrom = bars[0].date, fullTo = bars[bars.length - 1].date;
  const s = normDate(cfg.start), e = normDate(cfg.end);
  if (s) bars = bars.filter((b) => b.date >= s);
  if (e) bars = bars.filter((b) => b.date <= e);
  if (bars.length < 20) return { ok: false, error: '所选区间内有效交易日不足 20 天' };

  // 3) 准备
  const schedule = buildSchedule(bars, cfg);
  const fee = makeFeeCalc(cfg);
  const tiers = (Array.isArray(cfg.boostTiers) && cfg.boostTiers.length ? cfg.boostTiers : DEFAULT_TIERS)
    .slice().sort((a, b) => a.dev - b.dev);
  const ma = cfg.boostMode === 'ma' ? calcMA(bars, Math.max(2, Number(cfg.maPeriod) || 250)) : null;
  const baseAmount = Math.max(1, Number(cfg.amount) || 5000);
  const lot100 = cfg.lotMode !== 'exact';

  // 3.5) 分红/转增(红利再投): 仅对"除权(原始)"数据生效(前复权已含分红, 避免重复计)
  // 数据来源优先级: 前端传入 p.dividends > 本地库 globalStore > (引擎不主动联网, 保持离线)
  let divMap = new Map();
  let dividendApplied = false;
  let dividendSource = '';
  if (cfg.dividendReinvest && cfg.priceType !== 'qfq') {
    let divs = Array.isArray(p.dividends) ? p.dividends : null;
    if (!divs || !divs.length) {
      try { divs = require('../lib/globalStore').getDividends(code); dividendSource = 'local'; } catch (_) { divs = null; }
    } else { dividendSource = 'param'; }
    if (divs && divs.length) {
      const from = bars[0].date, to = bars[bars.length - 1].date;
      for (const d of divs) {
        if (d.exDate >= from && d.exDate <= to) divMap.set(d.exDate, d);
      }
      if (divMap.size) dividendApplied = true;
    }
  }

  // 4) 逐日推进
  let shares = 0;            // 本轮持股
  let invested = 0;          // 本轮投入(含费)
  let carry = 0;             // 结转余额
  let totalInvested = 0;     // 全局累计投入(含费)
  let realized = 0;          // 已实现净回收
  let totalFee = 0;
  let lastBuyPrice = 0;
  let periods = 0;
  let peakRet = 0, mddRet = 0, maxLoss = 0;
  let minCost = Infinity, firstCost = 0;
  const flows = [];          // XIRR 现金流
  const trades = [];
  const timeline = [];
  let stopped = false;
  let takeCount = 0;
  let downtickSkips = 0;
  let dividendReinvested = 0; // 累计红利再投金额(不计入本金)
  let dividendShares = 0;     // 红利再投买入股数
  let dividendEvents = 0;     // 实际发生的分红事件数

  for (let i = 0; i < bars.length && !stopped; i++) {
    const bar = bars[i];
    let buyRec = null, sellRec = null;

    // --- 定投买入 ---
    if (schedule.has(i)) {
      // 买入规则=下跌才买入: 仅当收盘价低于前一日收盘才买入, 上涨日跳过不操作
      if (cfg.buyRule === 'downtick' && i > 0 && bar.close >= bars[i - 1].close) {
        downtickSkips++;
      } else {
        const price = pickPrice(bar, cfg.priceMode);
        let qty = 0, planned = 0, mul = 1;
        if (cfg.buyMode === 'shares') {
          // 按股数模式: 每期固定股数(整百手模式下向下取整到整百), 不参与加码/结转
          qty = Math.max(0, Math.floor(Number(cfg.sharesPerPeriod)) || 0);
          if (lot100) qty = Math.floor(qty / 100) * 100;
        } else {
          // 按金额模式(默认): 计算可买股数, 不足 1 手则结转
          if (cfg.boostMode === 'ma' && ma) {
            const dev = ma[i] > 0 ? bar.close / ma[i] - 1 : 0;
            mul = pickMul(dev, tiers);
          } else if (cfg.boostMode === 'drop' && lastBuyPrice > 0) {
            const drop = (lastBuyPrice - bar.close) / lastBuyPrice;
            if (drop >= (Number(cfg.dropPct) || 5) / 100) mul = Number(cfg.dropMul) || 2;
          }
          planned = baseAmount * mul + (cfg.carryOver ? carry : 0);
          qty = lot100 ? Math.floor(planned / price / 100) * 100 : planned / price;
        }
        if (qty > 0) {
          const gross = qty * price;
          const f = fee.buy(gross);
          shares += qty; invested += gross + f; totalInvested += gross + f; totalFee += f;
          carry = cfg.buyMode === 'shares' ? 0 : (cfg.carryOver ? Math.max(0, planned - gross) : 0);
          lastBuyPrice = price; periods++;
          flows.push({ date: bar.date, amount: -(gross + f) });
          buyRec = { price: r4(price), shares: lot100 ? qty : r2(qty), amount: r2(gross), fee: r2(f), mul: cfg.buyMode === 'shares' ? 1 : mul };
          trades.push({
            seq: periods, date: bar.date, type: 'buy', price: r4(price),
            shares: lot100 ? qty : r2(qty), amount: r2(gross), fee: r2(f), mul: cfg.buyMode === 'shares' ? 1 : mul,
            cost_after: r4(invested / shares), shares_after: lot100 ? shares : r2(shares),
            invested_after: r2(invested),
          });
        } else if (cfg.buyMode !== 'shares') {
          carry = cfg.carryOver ? planned : 0; // 买不起 1 手, 全额结转
        }
      }
    }

    const mv = shares * bar.close;
    const cost = shares > 0 ? invested / shares : 0;
    if (shares > 0) { if (!firstCost) firstCost = cost; if (cost < minCost) minCost = cost; }

    // 定投口径回撤: 基于"累计收益率"序列的回落幅度(百分点), 并记录最大浮亏
    // 说明: 不用"市值峰值回撤", 因为定投的市值会被后续新投入持续抬高, 该口径会严重失真
    if (totalInvested > 0) {
      const retNow = (mv + realized - totalInvested) / totalInvested;
      if (retNow > peakRet) peakRet = retNow;
      const dd = peakRet - retNow;
      if (dd > mddRet) mddRet = dd;
      if (retNow < maxLoss) maxLoss = retNow;
    }

    // --- 止盈判定(每个交易日收盘) ---
    if (cfg.takeMode !== 'off' && shares > 0 && invested > 0) {
      const ret = (mv - invested) / invested;
      let hit = false;
      if (cfg.takeMode === 'ret') {
        hit = ret >= (Number(cfg.takeValue) || 30) / 100;
      } else if (cfg.takeMode === 'xirr' && ret > 0) {
        const f2 = flows.concat([{ date: bar.date, amount: mv }]);
        const rr = xirrFast(f2);
        hit = rr != null && rr >= (Number(cfg.takeValue) || 30) / 100;
      }
      if (hit) {
        const price = pickPrice(bar, cfg.priceMode);
        const gross = shares * price;
        const f = fee.sell(gross);
        const net = gross - f;
        realized += net; totalFee += f; takeCount++;
        flows.push({ date: bar.date, amount: net });
        sellRec = { price: r4(price), shares: lot100 ? shares : r2(shares), amount: r2(gross), fee: r2(f), profit: r2(net - invested) };
        trades.push({
          seq: periods, date: bar.date, type: 'sell', price: r4(price),
          shares: lot100 ? shares : r2(shares), amount: r2(gross), fee: r2(f), mul: 0,
          profit: r2(net - invested), ret_pct: r2((net - invested) / invested * 100),
        });
        shares = 0; invested = 0; carry = 0; lastBuyPrice = 0;
        if (cfg.afterTake === 'stop') stopped = true;
      }
    }

    // --- 红利再投(仅除权原始数据, 在除权除息日执行) ---
    let divRec = null;
    if (dividendApplied && divMap.has(bar.date) && shares > 0) {
      const dv = divMap.get(bar.date);
      const price = bar.close; // 除权除息日收盘(已反映除权跳空), 再投按此价买入
      // ① 现金分红: 按当日收盘自动买入, 增加股数(不计入本金)
      if (dv.cashPerShare > 0) {
        const cashAmt = dv.cashPerShare * shares;
        let addQty = lot100 ? Math.floor(cashAmt / price / 100) * 100 : cashAmt / price;
        if (addQty > 0) {
          const gross = addQty * price;
          const f = fee.buy(gross);
          shares += addQty; totalFee += f; dividendReinvested += gross + f; dividendShares += addQty;
          divRec = divRec || { cash: r4(dv.cashPerShare), bonus: r4(dv.bonusPerShare), transfer: r4(dv.transferPerShare) };
          divRec.cashShares = (divRec.cashShares || 0) + (lot100 ? addQty : r2(addQty));
        }
      }
      // ② 送股/转增: 按比例直接增加股数(无现金、无成本)
      const ratio = (dv.bonusPerShare || 0) + (dv.transferPerShare || 0);
      if (ratio > 0) {
        const addQty = shares * ratio;
        shares += addQty; dividendShares += addQty;
        divRec = divRec || { cash: r4(dv.cashPerShare), bonus: r4(dv.bonusPerShare), transfer: r4(dv.transferPerShare) };
        divRec.bonusShares = (divRec.bonusShares || 0) + r2(addQty);
      }
      if (divRec) {
        dividendEvents++; divRec.date = bar.date; divRec.sharesAfter = lot100 ? shares : r2(shares);
        trades.push({
          seq: periods, date: bar.date, type: 'dividend',
          cash: r4(dv.cashPerShare), bonus: r4(dv.bonusPerShare), transfer: r4(dv.transferPerShare),
          sharesAfter: lot100 ? shares : r2(shares),
        });
      }
    }

    const mv2 = shares * bar.close;
    timeline.push({
      d: bar.date, o: bar.open, h: bar.high, l: bar.low, c: bar.close,
      inv: r2(invested), sh: shares, cost: shares > 0 ? r4(invested / shares) : 0,
      mv: r2(mv2), pl: r2(mv2 - invested),
      ret: invested > 0 ? r2((mv2 - invested) / invested * 100) : 0,
      tinv: r2(totalInvested), rz: r2(realized),
      buy: buyRec, sell: sellRec, div: divRec,
    });
  }

  if (!periods) return { ok: false, error: '所选区间内未产生任何定投买入（可能期供金额不足 1 手，或区间过短）' };

  // 5) 汇总
  const last = bars[Math.min(timeline.length, bars.length) - 1];
  const marketValue = shares * last.close;
  const profit = marketValue + realized - totalInvested;
  const finalFlows = flows.concat(shares > 0 ? [{ date: last.date, amount: marketValue }] : []);
  const rr = xirr(finalFlows);

  const metrics = {
    invested: r2(totalInvested), shares: lot100 ? shares : r2(shares),
    cost: shares > 0 ? r4(invested / shares) : 0,
    market_value: r2(marketValue), realized: r2(realized),
    profit: r2(profit), return_pct: totalInvested > 0 ? r2(profit / totalInvested * 100) : 0,
    xirr: rr == null ? null : r2(rr * 100),
    mdd_pct: r2(mddRet * 100), max_loss_pct: r2(maxLoss * 100), periods, take_count: takeCount,
    downtick_skips: downtickSkips,
    dividend_reinvested: r2(dividendReinvested), dividend_shares: lot100 ? dividendShares : r2(dividendShares),
    dividend_events: dividendEvents, dividend_applied: dividendApplied,
    fee: r2(totalFee), carry: r2(carry),
    smile_index: firstCost > 0 && minCost < Infinity ? r2((firstCost - minCost) / firstCost * 100) : 0,
    days: bars.length, years: r2(bars.length / 244),
  };

  // 6) 对照组
  const compare = buildCompare({ bars, timeline, totalInvested, cfg, fee, lot100, last });

  // 7) timeline 抽稀(保证买/卖点不丢)
  const tl = thinTimeline(timeline, 3000);

  return {
    ok: true, strategy: 'dca', code,
    params: cfg,
    meta: {
      source, rows: cleaned.rawRows, valid: cleaned.bars.length, used: bars.length,
      skipped: cleaned.skipped, warnings: cleaned.warnings,
      full_from: fullFrom, full_to: fullTo, from: bars[0].date, to: last.date,
      dividend_reinvest: dividendApplied, dividend_source: dividendSource, dividend_count: divMap.size,
      timeline_full: timeline.length, timeline_step: Math.max(1, Math.ceil(timeline.length / 3000)),
    },
    metrics, compare, timeline: tl, trades,
  };
}

// 对照组: ① 首日一次性买入等额资金 ② 无风险利率储蓄
function buildCompare({ bars, timeline, totalInvested, cfg, fee, lot100, last }) {
  const out = {};
  // ① 一次性买入(首个定投日, 同价格口径, 同取整规则)
  const firstBuy = timeline.find((t) => t.buy);
  if (firstBuy && totalInvested > 0) {
    const price = firstBuy.buy.price;
    const budget = totalInvested;
    const qty = lot100 ? Math.floor(budget / price / 100) * 100 : budget / price;
    if (qty > 0) {
      const gross = qty * price;
      const f = fee.buy(gross);
      const mv = qty * last.close;
      const profit = mv - gross - f;
      const yrs = (Date.parse(last.date) - Date.parse(firstBuy.d)) / 86400000 / 365;
      out.lumpsum = {
        label: '首日一次性买入', date: firstBuy.d, price: r4(price), shares: lot100 ? qty : r2(qty),
        invested: r2(gross + f), market_value: r2(mv), profit: r2(profit),
        return_pct: r2(profit / (gross + f) * 100),
        xirr: yrs > 0 ? r2((Math.pow(mv / (gross + f), 1 / yrs) - 1) * 100) : null,
      };
    }
  }
  // ② 无风险储蓄: 每笔投入按年化复利到末日
  const rate = (Number(cfg.benchRate) || 3) / 100;
  let val = 0;
  for (const t of timeline) {
    if (!t.buy) continue;
    const cash = t.buy.amount + t.buy.fee;
    const yrs = (Date.parse(last.date) - Date.parse(t.d)) / 86400000 / 365;
    val += cash * Math.pow(1 + rate, yrs);
  }
  if (val > 0) {
    out.deposit = {
      label: '同期储蓄 ' + (rate * 100).toFixed(1) + '% 年化',
      invested: r2(totalInvested), market_value: r2(val), profit: r2(val - totalInvested),
      return_pct: r2((val - totalInvested) / totalInvested * 100), xirr: r2(rate * 100),
    };
  }
  return out;
}

// 抽稀: 保留全部买卖点 + 首尾 + 等间隔采样
function thinTimeline(tl, maxLen) {
  if (tl.length <= maxLen) return tl;
  const step = Math.ceil(tl.length / maxLen);
  const out = [];
  for (let i = 0; i < tl.length; i++) {
    if (i % step === 0 || tl[i].buy || tl[i].sell || tl[i].div || i === tl.length - 1) out.push(tl[i]);
  }
  return out;
}

module.exports = {
  runDca, normDate, num, cleanBars, buildSchedule, calcMA, xirr, DEFAULT_TIERS,
};
