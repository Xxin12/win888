'use strict';
/**
 * A股短线策略信号检测 (移植自 "A股短线交易" 技能的标的初筛规则集 S00~S07)
 *
 * 每个策略对日K序列检测"买入信号日"索引数组。引擎拿到信号后, 由 execute.js
 * 统一执行(次日开盘买入 / 持有N日或止损止盈卖出), 从而把"选股规则"变成可回测的"交易策略"。
 *
 * 数据依赖(由 eastmoney_day 提供): close/open/high/low/volume/amount(元)/turnover(换手%)/amplitude(振幅%)
 * 说明: 技能原规则含"非ST"判定, 因回测无名称/ST标记, 此处省略(可后续补);
 *       金额阈值按 amount(元)换算: 24亿 = 2.4e9。
 */
const { SMA } = require('../../lib/indicators');

// 滚动窗口最大(返回等长数组, 前 w-1 个为 null)
function rollMax(arr, w) {
  const out = new Array(arr.length).fill(null);
  for (let i = 0; i < arr.length; i++) {
    if (i < w - 1) continue;
    let m = -Infinity;
    for (let j = i - w + 1; j <= i; j++) m = Math.max(m, arr[j]);
    out[i] = m;
  }
  return out;
}
function mean(a) { return a.reduce((s, x) => s + x, 0) / a.length; }

/** 预计算各均线/滚动高, 一次搞定, 供所有规则复用 */
function prep(bars) {
  const close = bars.map((b) => b.close);
  const vol = bars.map((b) => b.volume);
  const high = bars.map((b) => b.high);
  // 振幅% 由 high/low/昨收 计算(东财 amplitude 字段不一定落盘, 故统一在此算, 保证回读一致)
  const amp = bars.map((b, i) => (i === 0 || !bars[i - 1].close) ? 0 : +(((b.high - b.low) / bars[i - 1].close) * 100).toFixed(3));
  return {
    close, vol, high, amp,
    ma5: SMA(close, 5), ma10: SMA(close, 10), ma20: SMA(close, 20),
    ma30: SMA(close, 30), ma60: SMA(close, 60),
    mav5: SMA(vol, 5), mav10: SMA(vol, 10), mav20: SMA(vol, 20),
    high10Prev: rollMax(high, 10),       // 含当日, 规则内自行取前N日
    high60Close: rollMax(close, 60),     // 含当日(用于新高判定)
  };
}

// ---- S00 放量突破新高: 非ST + 3日巨量 + 连续站上MA5 + 3日成交额>24亿 + 换手≤50% + 后复权新高 ----
function s00(bars, P) {
  const out = [];
  for (let i = 60; i < bars.length; i++) {
    if ([P.ma5[i], P.ma20[i], P.ma30[i], P.ma60[i], P.mav5[i], P.mav20[i]].some((x) => x == null)) continue;
    let ok = true;
    for (let j = i - 2; j <= i; j++) {
      if (!(bars[j].volume > P.mav20[j] * 1.5)) { ok = false; break; }   // 3日巨量
      if (!(bars[j].close > P.ma5[j])) { ok = false; break; }            // 连续站上MA5
      if (bars[j].turnover != null && !(bars[j].turnover <= 50)) { ok = false; break; } // 换手≤50%(缺失视为通过→降级)
    }
    if (!ok) continue;
    const amt3 = bars[i].amount + bars[i - 1].amount + bars[i - 2].amount;
    if (amt3 <= 2.4e9) continue;                                          // 3日成交额>24亿
    if (bars[i].close !== P.high60Close[i]) continue;                     // 后复权(前复权)新高
    out.push(i);
  }
  return out;
}

// ---- S01 量能验证突破: 当日量 ≥ 5日均量150% 且 收盘突破近10日高点 ----
function s01(bars, P) {
  const out = [];
  for (let i = 10; i < bars.length; i++) {
    if (P.mav5[i] == null || P.high10Prev[i - 1] == null) continue;
    if (bars[i].volume < P.mav5[i] * 1.5) continue;
    const prev10High = Math.max(...bars.slice(i - 10, i).map((b) => b.high)); // 不含当日
    if (bars[i].close <= prev10High) continue;
    out.push(i);
  }
  return out;
}

// ---- S02 低位均线回踩: 股价贴近30日均线(±2%) 且 20日均量收缩 ----
function s02(bars, P) {
  const out = [];
  for (let i = 30; i < bars.length; i++) {
    if (P.ma30[i] == null || P.mav20[i] == null) continue;
    if (Math.abs(bars[i].close - P.ma30[i]) / P.ma30[i] > 0.02) continue;
    if (bars[i].volume >= P.mav20[i] * 0.9) continue; // 量低于20均量=收缩
    out.push(i);
  }
  return out;
}

// ---- S03 封板次日跟踪: 当日涨停(非一字板) + 换手5-15% (信号日=涨停日, 次日开盘买) ----
function s03(bars, P) {
  const out = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    if (b.pct == null || isNaN(b.pct)) continue;
    if (b.pct < 9.5) continue;                       // 涨停(涨跌幅≥9.5%)
    if (!(b.high > b.low)) continue;                 // 非一字板(有日内振幅)
    if (b.turnover != null && (b.turnover < 5 || b.turnover > 15)) continue; // 换手5-15%(缺失视为无信号→降级)
    out.push(i);
  }
  return out;
}

// ---- S04 强势回调整理: 近10日涨幅>15% 且 当日缩量回调≤3% ----
function s04(bars, P) {
  const out = [];
  for (let i = 10; i < bars.length; i++) {
    if (P.mav5[i] == null) continue;
    if (bars[i].close / bars[i - 10].close - 1 <= 0.15) continue; // 近10日涨幅>15%
    if (!(bars[i].pct <= 0 && bars[i].pct >= -3)) continue;       // 当日回调且≤3%
    if (bars[i].volume >= P.mav5[i] * 0.8) continue;             // 缩量
    out.push(i);
  }
  return out;
}

// ---- S06 缩量蓄势: 5日振幅≤3% 且 量能持续萎缩(低于10日均量) ----
function s06(bars, P) {
  const out = [];
  for (let i = 10; i < bars.length; i++) {
    if (P.mav10[i] == null) continue;
    const amp5 = mean(P.amp.slice(i - 4, i + 1)); // 5日振幅均值(由high/low/昨收算)
    if (amp5 > 3) continue;                       // 5日振幅≤3%
    if (bars[i].volume >= P.mav10[i]) continue;   // 量低于10日均量=萎缩
    out.push(i);
  }
  return out;
}

const RULES = {
  S00: { label: 'S00 放量突破新高(3日巨量+站上MA5+成交额>24亿+换手≤50%+新高)', detect: s00 },
  S01: { label: 'S01 量能验证突破(量≥5均量150% & 收盘破近10日高)', detect: s01 },
  S02: { label: 'S02 低位均线回踩(贴30日线±2% & 量收缩)', detect: s02 },
  S03: { label: 'S03 封板次日跟踪(涨停非一字 & 换手5-15%, 次日开盘买)', detect: s03 },
  S04: { label: 'S04 强势回调整理(10日涨>15% & 缩量回调≤3%)', detect: s04 },
  S06: { label: 'S06 缩量蓄势(5日振幅≤3% & 量低于10均量)', detect: s06 },
};

/** 对所有规则检测信号; 返回 {S00:[idx...], ...} */
function detectAll(bars) {
  const P = prep(bars);
  const res = {};
  for (const k of Object.keys(RULES)) res[k] = RULES[k].detect(bars, P);
  return res;
}

module.exports = { RULES, detectAll, prep };
