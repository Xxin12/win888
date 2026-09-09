'use strict';
/**
 * MA金叉/死叉策略 (示例, 验证策略接口可扩展)
 * 基于日K: 短均线上穿长均线买入(满仓qty), 下穿卖出。逐笔配对成交易记录。
 * 费率同做T。
 */
const { SMA } = require('../../lib/indicators');
const BUY_RATE = 0.0001;
const SELL_RATE = 0.0006;

function run(dayBars, qty, { fast = 5, slow = 20 } = {}) {
  const closes = dayBars.map((b) => b.close);
  const mf = SMA(closes, fast);
  const ms = SMA(closes, slow);
  const trades = [];
  let holding = false, buyPrice = 0, buyDate = '';
  for (let i = 1; i < dayBars.length; i++) {
    if (mf[i] == null || ms[i] == null || mf[i - 1] == null || ms[i - 1] == null) continue;
    const goldCross = mf[i - 1] <= ms[i - 1] && mf[i] > ms[i];
    const deadCross = mf[i - 1] >= ms[i - 1] && mf[i] < ms[i];
    if (!holding && goldCross) {
      holding = true; buyPrice = dayBars[i].close; buyDate = dayBars[i].date;
    } else if (holding && deadCross) {
      const sp = dayBars[i].close;
      const gross = (sp - buyPrice) * qty;
      const fee = BUY_RATE * buyPrice * qty + SELL_RATE * sp * qty;
      trades.push({
        date: dayBars[i].date, buy_date: buyDate,
        buy_p: +buyPrice.toFixed(3), sell_p: +sp.toFixed(3),
        gross: +gross.toFixed(2), fee: +fee.toFixed(2), net: +(gross - fee).toFixed(2),
      });
      holding = false;
    }
  }
  return trades;
}

module.exports = { label: 'MA金叉买/死叉卖 (日K, 5/20)', run };
