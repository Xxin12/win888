'use strict';
/**
 * 做T策略 (移植 backtest_v2.py)
 * 每日强制配对: 买=卖=qty 股, 不留隔夜, 无论当日是否盈利。
 * 费率: 买 0.01%, 卖 0.06%(印花税0.05%+佣金0.01%)
 * 三档:
 *   standard(推荐, 非极端): 上午(剔除09:35)最低收盘买 -> 下午最高收盘卖
 *   naive(对照, 无未来函数): 11:30收盘买 -> 15:00收盘卖
 *   ideal(上限, 含未来函数): 当日最低Low买 -> 其后最高High卖
 */
const BUY_RATE = 0.0001;
const SELL_RATE = 0.0006;

function fees(bp, sp, qty) {
  return BUY_RATE * bp * qty + SELL_RATE * sp * qty;
}

function trade(date, bp, sp, qty) {
  const gross = (sp - bp) * qty;
  const fee = fees(bp, sp, qty);
  return { date, buy_p: +bp.toFixed(3), sell_p: +sp.toFixed(3), gross: +gross.toFixed(2), fee: +fee.toFixed(2), net: +(gross - fee).toFixed(2) };
}

/** 将 {date, buy_p, sell_p} 列表补全为含 gross/fee/net 的完整交易(供自定义/手动策略复用) */
function finalizeTrades(trades, qty) {
  return (trades || []).map((t) => {
    const bp = +Number(t.buy_p).toFixed(3);
    const sp = +Number(t.sell_p).toFixed(3);
    const gross = (sp - bp) * qty;
    const fee = BUY_RATE * bp * qty + SELL_RATE * sp * qty;
    return {
      date: t.date, buy_p: bp, sell_p: sp,
      buy_time: t.buy_time, sell_time: t.sell_time,
      gross: +gross.toFixed(2), fee: +fee.toFixed(2), net: +(gross - fee).toFixed(2),
    };
  });
}

function runStandard(days, qty) {
  const out = [];
  for (const { date, bars } of days) {
    const morning = bars.filter((b) => b.t >= '09:40' && b.t <= '11:30');
    const afternoon = bars.filter((b) => b.t >= '13:00');
    if (morning.length === 0 || afternoon.length === 0) continue;
    const bp = Math.min(...morning.map((b) => b.close));
    const sp = Math.max(...afternoon.map((b) => b.close));
    out.push(trade(date, bp, sp, qty));
  }
  return out;
}

function runNaive(days, qty) {
  const out = [];
  for (const { date, bars } of days) {
    const b1130 = bars.filter((b) => b.t <= '11:30').slice(-1)[0];
    const b1500 = bars.slice(-1)[0];
    if (!b1130 || !b1500) continue;
    out.push(trade(date, b1130.close, b1500.close, qty));
  }
  return out;
}

function runIdeal(days, qty) {
  const out = [];
  for (const { date, bars } of days) {
    // 当日最低Low, 及其之后的最高High
    let loIdx = 0, lo = Infinity;
    bars.forEach((b, i) => { if (b.low < lo) { lo = b.low; loIdx = i; } });
    let hi = -Infinity;
    for (let i = loIdx; i < bars.length; i++) hi = Math.max(hi, bars[i].high);
    if (hi <= 0 || lo === Infinity) continue;
    out.push(trade(date, lo, hi, qty));
  }
  return out;
}

module.exports = {
  BUY_RATE, SELL_RATE, fees, finalizeTrades,
  variants: {
    standard: { label: '标准T(上午剔除09:35最低收盘买→下午最高收盘卖)', run: runStandard },
    naive: { label: '朴素持有对照(11:30买→15:00卖,无未来函数)', run: runNaive },
    ideal: { label: '极端理想T(当日最低Low→其后最高High,含未来函数,仅上限)', run: runIdeal },
  },
};
