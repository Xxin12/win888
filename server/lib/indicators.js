'use strict';
/**
 * 技术指标计算 (纯函数, 输入 closes/highs/lows 数组)
 * 返回与输入等长的数组, 不足周期处为 null
 */

function SMA(arr, n) {
  const out = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= n) sum -= arr[i - n];
    if (i >= n - 1) out[i] = +(sum / n).toFixed(4);
  }
  return out;
}

function EMA(arr, n) {
  const out = new Array(arr.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] == null) { out[i] = prev; continue; }
    prev = prev == null ? arr[i] : arr[i] * k + prev * (1 - k);
    out[i] = +prev.toFixed(4);
  }
  return out;
}

/** MA 多条 */
function MA(closes, periods = [5, 10, 20, 60]) {
  const res = {};
  periods.forEach((p) => (res['MA' + p] = SMA(closes, p)));
  return res;
}

/** MACD (12,26,9) -> {dif, dea, macd} */
function MACD(closes, fast = 12, slow = 26, sig = 9) {
  const ef = EMA(closes, fast);
  const es = EMA(closes, slow);
  const dif = closes.map((_, i) =>
    ef[i] == null || es[i] == null ? null : +(ef[i] - es[i]).toFixed(4)
  );
  const difClean = dif.map((v) => (v == null ? 0 : v));
  const dea = EMA(difClean, sig).map((v, i) => (dif[i] == null ? null : v));
  const macd = dif.map((d, i) =>
    d == null || dea[i] == null ? null : +((d - dea[i]) * 2).toFixed(4)
  );
  return { dif, dea, macd };
}

/** KDJ (9,3,3) */
function KDJ(highs, lows, closes, n = 9) {
  const K = new Array(closes.length).fill(null);
  const D = new Array(closes.length).fill(null);
  const J = new Array(closes.length).fill(null);
  let k = 50, d = 50;
  for (let i = 0; i < closes.length; i++) {
    if (i < n - 1) continue;
    let hh = -Infinity, ll = Infinity;
    for (let j = i - n + 1; j <= i; j++) { hh = Math.max(hh, highs[j]); ll = Math.min(ll, lows[j]); }
    const rsv = hh === ll ? 0 : ((closes[i] - ll) / (hh - ll)) * 100;
    k = (2 / 3) * k + (1 / 3) * rsv;
    d = (2 / 3) * d + (1 / 3) * k;
    K[i] = +k.toFixed(3); D[i] = +d.toFixed(3); J[i] = +(3 * k - 2 * d).toFixed(3);
  }
  return { K, D, J };
}

/** BOLL (20,2) */
function BOLL(closes, n = 20, k = 2) {
  const mid = SMA(closes, n);
  const up = new Array(closes.length).fill(null);
  const low = new Array(closes.length).fill(null);
  for (let i = n - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = i - n + 1; j <= i; j++) sum += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(sum / n);
    up[i] = +(mid[i] + k * sd).toFixed(4);
    low[i] = +(mid[i] - k * sd).toFixed(4);
  }
  return { mid, up, low };
}

/** 计算全部指标, 输入 bars=[{open,high,low,close}] */
function computeAll(bars, types = ['MA', 'MACD', 'KDJ', 'BOLL']) {
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const out = {};
  if (types.includes('MA')) out.MA = MA(closes);
  if (types.includes('MACD')) out.MACD = MACD(closes);
  if (types.includes('KDJ')) out.KDJ = KDJ(highs, lows, closes);
  if (types.includes('BOLL')) out.BOLL = BOLL(closes);
  return out;
}

module.exports = { SMA, EMA, MA, MACD, KDJ, BOLL, computeAll };
