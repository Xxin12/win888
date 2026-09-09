'use strict';
/**
 * 手动买卖点 → 回测策略（公式化，覆盖全部分时日期）
 * ----------------------------------------------------------------
 * 语义变更：手动买卖点不再按"字面点位只回测点选当天"，而是把用户点选的买卖点
 * 当作"锚点"，用 锚点价格 / 当时均价 的比例推导出一个通用公式：
 *   - 买入比 rBuy   = Σ(买点.price / 买点.avg) / 买点数      （价格相对均价越低越买）
 *   - 卖出比 rSell  = Σ(卖点.price / 卖点.avg) / 卖点数      （价格相对均价越高越卖）
 * 公式：对任意交易日分钟棒，当 price/avg <= rBuy 且空仓→买入；当 price/avg >= rSell 且持仓→卖出（T+0，收盘前强制平仓）。
 * 该公式对股票"全部分时日期"逐日回测，汇总成策略绩效。
 *
 * marks: [{ date:'YYYY-MM-DD', time:'HH:MM', price:Number, avg?:Number, type:'buy'|'sell' }]
 *   avg 可选：点击时由前端带上(该分钟均价)，缺失时引擎回查 anchor 日分时补齐。
 */
const intraday = require('../lib/intradayRecorder');
const ms = require('../lib/marketStore');

const BUY_RATE = 0.0001;
const SELL_RATE = 0.0006;

// 取某交易日分钟级分时 [{t, price, avg}]; 优先 intraday, 无则 5分钟回退重建(VWAP 均价)
async function getDayBars(code, date) {
  let rows = null;
  try { rows = intraday.loadDate(code, date); } catch (_) { rows = null; }
  if (rows && rows.length) {
    return rows
      .filter((b) => b && isFinite(Number(b.price)))
      .map((b) => ({ t: b.t, price: +Number(b.price).toFixed(3), avg: isFinite(Number(b.avg)) ? +Number(b.avg).toFixed(3) : null }));
  }
  // 5分钟回退: 用 成交额/成交量 重建当日均价(累计 VWAP); volume 单位为「手」, 故 /100 还原为「股」
  const allK5 = ms.get5minBars(code) || [];
  const bars = allK5.filter((b) => b.date === date);
  if (!bars.length) return [];
  let cumA = 0, cumV = 0;
  return bars.map((b) => {
    cumA += (b.amount || 0);
    cumV += (b.volume || 0);
    const avg = cumV > 0 ? +(cumA / (cumV * 100)).toFixed(3) : (b.close || 0);
    return { t: (b.datetime || '').slice(11, 16), price: +(b.close || 0).toFixed(3), avg };
  });
}

// 由锚点 marks 派生公式(买/卖 价格对均价之比)。avg 缺失时回查 anchor 日分时补齐。
async function deriveFormula(code, marks) {
  const buys = [], sells = [];
  for (const m of (marks || [])) {
    if (!m || (m.type !== 'buy' && m.type !== 'sell')) continue;
    if (!m.date || !isFinite(Number(m.price))) continue;
    let avg = Number(m.avg);
    if (!isFinite(avg) || avg <= 0) {
      try {
        const rows = await getDayBars(code, m.date);
        const hit = rows.find((r) => r.t === m.time);
        avg = hit && isFinite(hit.avg) ? hit.avg : 0;
      } catch (_) { avg = 0; }
    }
    if (!isFinite(avg) || avg <= 0) continue; // 均价无效则跳过该锚点
    const ratio = Number(m.price) / avg;
    if (m.type === 'buy') buys.push(ratio);
    else sells.push(ratio);
  }
  if (!buys.length || !sells.length) {
    return { ok: false, reason: 'need-both', buys: buys.length, sells: sells.length };
  }
  const avgOf = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  return { ok: true, rBuy: +avgOf(buys).toFixed(4), rSell: +avgOf(sells).toFixed(4) };
}

// 用公式对股票全部分时日期做回测(T+0, 每日至多一笔配对, 收盘前强制平仓)
async function runManualBacktest(code, qty, marks) {
  const f = await deriveFormula(code, marks);
  if (!f.ok) return { ok: false, error: '需同时设置买点与卖点（且均含有效均价）才能由锚点推导回测公式' };

  const dates = intraday.listDates(code) || []; // 分钟级全日期(降序)
  const trades = [];
  let evaluated = 0, skipped = 0;
  for (const date of dates) {
    let bars = null;
    try { bars = await getDayBars(code, date); } catch (_) { bars = null; }
    if (!bars || bars.length < 10) { skipped++; continue; }
    evaluated++;
    let holding = false, buyP = 0, buyT = null;
    for (const bar of bars) {
      const avg = Number(bar.avg);
      if (!isFinite(avg) || avg <= 0) continue;
      const ratio = Number(bar.price) / avg;
      if (!holding && ratio <= f.rBuy) {
        holding = true; buyP = +Number(bar.price).toFixed(3); buyT = bar.t;
      } else if (holding && ratio >= f.rSell) {
        const sp = +Number(bar.price).toFixed(3);
        const gross = (sp - buyP) * qty;
        const fee = BUY_RATE * buyP * qty + SELL_RATE * sp * qty;
        trades.push({ date, buy_time: buyT, sell_time: bar.t, buy_p: buyP, sell_p: sp, gross: +gross.toFixed(2), fee: +fee.toFixed(2), net: +(gross - fee).toFixed(2) });
        holding = false;
      }
    }
    // T+0: 收盘前仍持仓则强制以最后一根平仓, 不留隔夜
    if (holding) {
      const last = bars[bars.length - 1];
      const sp = +Number(last.price).toFixed(3);
      const gross = (sp - buyP) * qty;
      const fee = BUY_RATE * buyP * qty + SELL_RATE * sp * qty;
      trades.push({ date, buy_time: buyT, sell_time: last.t, buy_p: buyP, sell_p: sp, gross: +gross.toFixed(2), fee: +fee.toFixed(2), net: +(gross - fee).toFixed(2), forced: true });
    }
  }

  if (!trades.length) {
    return { ok: false, error: `公式（买比≤${f.rBuy} / 卖比≥${f.rSell}）在该股票全部分时日期上均未触发有效买卖，请调整点选的买卖点位置` };
  }
  const tradeDays = new Set(trades.map((t) => t.date)).size;
  return { ok: true, formula: f, trades, evaluated, skipped, totalDates: dates.length, tradeDays };
}

/**
 * 旧版：字面点位直接配对（仅点选当天）。保留供兼容/参考，新回测统一走 runManualBacktest。
 * marks: 按 日期→时间 升序配对; 买点后第一个卖点成一笔; 不成对买点/孤立卖点忽略。
 */
function computeFromMarks(marks, qty) {
  const valid = (marks || []).filter(
    (m) => m && (m.type === 'buy' || m.type === 'sell') && m.date && isFinite(Number(m.price))
  );
  valid.sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.time < b.time ? -1 : a.time > b.time ? 1 : 0
  );
  const trades = [];
  let pending = null;
  for (const m of valid) {
    if (m.type === 'buy') {
      pending = m;
    } else if (m.type === 'sell') {
      if (pending) {
        const bp = +Number(pending.price).toFixed(3);
        const sp = +Number(m.price).toFixed(3);
        const gross = (sp - bp) * qty;
        const fee = BUY_RATE * bp * qty + SELL_RATE * sp * qty;
        trades.push({
          date: pending.date, buy_time: pending.time, sell_time: m.time,
          buy_p: bp, sell_p: sp, gross: +gross.toFixed(2), fee: +fee.toFixed(2), net: +(gross - fee).toFixed(2),
        });
        pending = null;
      }
    }
  }
  return { trades, unpairedBuys: pending ? 1 : 0 };
}

module.exports = { computeFromMarks, runManualBacktest, deriveFormula, getDayBars, BUY_RATE, SELL_RATE };
