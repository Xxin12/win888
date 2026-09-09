'use strict';
/**
 * 通用信号执行器 (server/backtest/execute.js)
 * 把"信号日索引数组"变成真实交易记录, 统一短线策略的执行口径以便横向对比:
 *   - 买入: 信号日【次日开盘】(避免未来函数); 若次日不存在则跳过
 *   - 卖出: 在 [买入日, 买入日+holdDays] 区间内, 取以下最早触发者:
 *        * 止损: 某日最低价 <= 买入价*(1-stopPct) -> 以止损价成交
 *        * 止盈: 某日最高价 >= 买入价*(1+takePct) -> 以止盈价成交
 *        * 到期: 持有满 holdDays 个交易日 -> 以当日收盘成交
 *   - 同一时刻只持有一仓(信号重叠时跳过已在持仓期间的信号)
 *   - 费率: 买0.01% 卖0.06% (与做T一致)
 */
const BUY_RATE = 0.0001;
const SELL_RATE = 0.0006;

/**
 * @param {Array} bars 日K(含 open/high/low/close/date)
 * @param {number[]} signals 买入信号日索引(基于 bars)
 * @param {{qty?:number, holdDays?:number, stopPct?:number, takePct?:number}} opt
 * @returns {{trades:Array, skipped:number}}
 */
function execute(bars, signals, { qty = 2000, holdDays = 5, stopPct = 0.05, takePct = 0.08 } = {}) {
  const trades = [];
  let holding = false;
  let holdEnd = -1; // 当前持仓的到期索引(用于重叠跳过)

  for (const sig of signals) {
    const buyIdx = sig + 1; // 次日开盘买入
    if (buyIdx >= bars.length) continue;
    if (holding && buyIdx <= holdEnd) continue; // 持仓期间不重复开仓

    const bp = bars[buyIdx].open;
    if (!bp || bp <= 0) continue;
    const sellLimit = Math.min(buyIdx + holdDays, bars.length - 1);
    let sp = null, reason = '', sellIdx = -1;

    for (let j = buyIdx; j <= sellLimit; j++) {
      const lo = bars[j].low, hi = bars[j].high;
      // 止损优先于止盈(同根K先触止损)
      if (lo <= bp * (1 - stopPct)) { sp = +(bp * (1 - stopPct)).toFixed(3); reason = 'stop'; sellIdx = j; break; }
      if (hi >= bp * (1 + takePct)) { sp = +(bp * (1 + takePct)).toFixed(3); reason = 'take'; sellIdx = j; break; }
      if (j === sellLimit) { sp = +bars[j].close.toFixed(3); reason = 'expire'; sellIdx = j; }
    }
    if (sp == null) { sp = +bars[bars.length - 1].close.toFixed(3); reason = 'tail'; sellIdx = bars.length - 1; }

    const gross = (sp - bp) * qty;
    const fee = BUY_RATE * bp * qty + SELL_RATE * sp * qty;
    trades.push({
      date: bars[buyIdx].date,            // 买入日
      buy_date: bars[buyIdx].date,
      sell_date: bars[sellIdx].date,     // 卖出日
      buy_p: +bp.toFixed(3),
      sell_p: sp,
      gross: +gross.toFixed(2),
      fee: +fee.toFixed(2),
      net: +(gross - fee).toFixed(2),
      hold_days: sellIdx - buyIdx,
      exit_reason: reason,
    });
    holding = true;
    holdEnd = sellIdx;
  }
  return { trades, skipped: signals.length - trades.length };
}

module.exports = { execute, BUY_RATE, SELL_RATE };
