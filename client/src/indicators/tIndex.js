// 通达信「日内T」指标 (JS 移植) —— 用于当日分时图下方副图
// 说明: 分时数据仅含每分钟收盘价(price)与成交量, 缺失每分钟 high/low,
//       故以 price 同时作为 high/low 代理(每根"分钟K" high=low=close),
//       指标周期按"分钟"理解(如 HHV(55)=最近55分钟最高价)。
//       如需精确, 应接入真实1分钟K线(含 H/L)替换 price 代理。

const ABS = (x) => Math.abs(x);
const MAX = (a, b) => (a > b ? a : b);
const MIN = (a, b) => (a < b ? a : b);

// N 周期最高
function HHV(arr, n) {
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let m = arr[i];
    const s = Math.max(0, i - n + 1);
    for (let j = s; j <= i; j++) if (arr[j] > m) m = arr[j];
    out[i] = m;
  }
  return out;
}
// N 周期最低
function LLV(arr, n) {
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let m = arr[i];
    const s = Math.max(0, i - n + 1);
    for (let j = s; j <= i; j++) if (arr[j] < m) m = arr[j];
    out[i] = m;
  }
  return out;
}
// N 周期前的值
function REF(arr, n) {
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = i >= n ? arr[i - n] : arr[0];
  return out;
}
// 通达信 SMA(X,N,M): 首值=X[0], 之后 = (M*X + (N-M)*prev)/N
function SMA(arr, n, m) {
  const out = new Array(arr.length);
  if (!arr.length) return out;
  let prev = arr[0];
  out[0] = arr[0];
  for (let i = 1; i < arr.length; i++) {
    prev = (m * arr[i] + (n - m) * prev) / n;
    out[i] = prev;
  }
  return out;
}
// 指数平滑 EMA(X,N)
function EMA(arr, n) {
  const out = new Array(arr.length);
  if (!arr.length) return out;
  const k = 2 / (n + 1);
  let prev = arr[0];
  out[0] = arr[0];
  for (let i = 1; i < arr.length; i++) {
    prev = arr[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}
// 简单移动平均
function MA(arr, n) {
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const s = Math.max(0, i - n + 1);
    let sum = 0;
    for (let j = s; j <= i; j++) sum += arr[j];
    out[i] = sum / (i - s + 1);
  }
  return out;
}
// A 上穿 B (金叉)
function CROSS(a, b) {
  const out = new Array(a.length).fill(false);
  for (let i = 1; i < a.length; i++) out[i] = a[i] > b[i] && a[i - 1] <= b[i - 1];
  return out;
}
// 上一次条件成立到当前的周期数
function BARSLAST(cond) {
  const out = new Array(cond.length).fill(-1);
  let last = -1;
  for (let i = 0; i < cond.length; i++) {
    if (cond[i]) last = i;
    out[i] = last === -1 ? -1 : i - last;
  }
  return out;
}
// FILTER(cond,N): 条件成立且前 N 周期内未成立过 -> 真
function FILTER(cond, n) {
  const out = new Array(cond.length).fill(false);
  let lastTrue = -1e9;
  for (let i = 0; i < cond.length; i++) {
    if (cond[i] && i - lastTrue > n) { out[i] = true; lastTrue = i; }
  }
  return out;
}
// 保护除零
function div(a, b) {
  if (b === 0 || (typeof b === 'number' && !isFinite(b))) return 0;
  return a / b;
}
// 威尔德抛物线转向 SAR(high,low,N,step,maxStep)
function SAR(high, low, n = 10, step = 0.02, maxStep = 0.2) {
  const len = high.length;
  const sar = new Array(len).fill(null);
  if (len < 2) return sar;
  let isLong = high[1] >= low[0];
  let ep = isLong ? high[0] : low[0];
  let af = step;
  let cur = isLong ? low[0] : high[0];
  sar[0] = cur;
  for (let i = 1; i < len; i++) {
    let prev = cur;
    let next;
    if (isLong) {
      next = prev + af * (ep - prev);
      next = Math.min(next, low[i - 1], i >= 2 ? low[i - 2] : low[i - 1]);
      if (low[i] < next) { isLong = false; next = ep; ep = low[i]; af = step; }
      else if (high[i] > ep) { ep = high[i]; af = Math.min(af + step, maxStep); }
    } else {
      next = prev - af * (prev - ep);
      next = Math.max(next, high[i - 1], i >= 2 ? high[i - 2] : high[i - 1]);
      if (high[i] > next) { isLong = true; next = ep; ep = high[i]; af = step; }
      else if (low[i] < ep) { ep = low[i]; af = Math.min(af + step, maxStep); }
    }
    cur = next;
    sar[i] = cur;
  }
  return sar;
}

// 主计算: 输入分时数组 [{t,price,avg,volume,cumVolume}], 输出副图序列
export function computeIntradayT(minute) {
  const n = minute.length;
  const close = minute.map((d) => d.price);
  const high = close.slice(); // 代理: 分时缺 H, 以收盘价代替
  const low = close.slice();  // 代理: 分时缺 L, 以收盘价代替

  const hh55 = HHV(high, 55), ll55 = LLV(low, 55);
  const hh27 = HHV(high, 27), ll27 = LLV(low, 27);
  const hh30 = HHV(high, 30), ll30 = LLV(low, 30);

  // 空方力度 := 100*(HHV(HIGH,55)-CLOSE)/(HHV(HIGH,55)-LLV(LOW,55))
  const 空方力度 = close.map((c, i) => 100 * div(hh55[i] - c, hh55[i] - ll55[i]));

  // 多方力度 := 3*SMA(...,5,1) - 2*SMA(SMA(...,5,1),3,1)
  const x27 = close.map((c, i) => 100 * div(c - ll27[i], hh27[i] - ll27[i]));
  const smaX27 = SMA(x27, 5, 1);
  const smaSmaX27 = SMA(smaX27, 3, 1);
  const 多方力度 = smaX27.map((v, i) => 3 * v - 2 * smaSmaX27[i]);

  // RSV / K / D / J (30)
  const rsv = close.map((c, i) => 100 * div(c - ll30[i], hh30[i] - ll30[i]));
  const K = SMA(rsv, 3, 1), D = SMA(K, 3, 1);
  // J 仅用于公式完整性, 副图不直接画

  // RSI
  const lc = REF(close, 1);
  const up = close.map((c, i) => MAX(c - lc[i], 0));
  const dn = close.map((c, i) => ABS(c - lc[i]));
  const smaUp = SMA(up, 3, 1), smaDn = SMA(dn, 3, 1);
  const RSI = smaUp.map((u, i) => 100 * div(u, smaDn[i]));

  // 趋势 (VAR3)
  const x55 = close.map((c, i) => 100 * div(c - ll55[i], hh55[i] - ll55[i]));
  const smaX55 = SMA(x55, 5, 1);
  const VAR3 = smaX55.map((v, i) => 3 * v - 2 * SMA(smaX55, 3, 1)[i]);
  const 趋势 = EMA(VAR3, 3).map((v) => v - 10);
  const refTrend = REF(趋势, 1);
  const VAR4 = 趋势.map((v, i) => 100 * div(v - refTrend[i], refTrend[i] || 1));
  const VAR5 = FILTER(趋势.map((v, i) => v <= 13 && VAR4[i] > 13), 10); // 底
  const VAR6 = FILTER(趋势.map((v, i) => v >= 90 && VAR4[i]), 10);     // 顶

  // 主力吸筹
  const VAR3333 = close.map((c, i) => {
    const diff = i > 0 ? low[i] - low[i - 1] : 0;
    const a = ABS(diff), b = MAX(diff, 0);
    const sa = SMA(close.map((_, j) => ABS((j > 0 ? low[j] - low[j - 1] : 0))), 3, 1)[i];
    const sb = SMA(close.map((_, j) => MAX((j > 0 ? low[j] - low[j - 1] : 0), 0)), 3, 1)[i];
    return 100 * div(sa, sb);
  });
  const VAR4444 = EMA(VAR3333.map((v) => v * 10), 3); // IF(close*1.3,...) 恒真分支
  const VAR5555 = LLV(low, 30);
  const VAR6666 = HHV(VAR4444, 30);
  const 主力吸筹 = EMA(
    close.map((c, i) => (low[i] <= VAR5555[i] ? (VAR4444[i] + 2 * VAR6666[i]) / 2 : 0)),
    3
  ).map((v) => div(v, 618));
  const 主力吸筹C = 主力吸筹.map((v) => (v > 100 ? 100 : v));

  // 持股 / 持币 (SAR)
  const sar = SAR(high, low, 10, 0.02, 0.2);
  const 持股 = sar.map((s, i) => s != null && s <= low[i]);
  const 持币 = sar.map((s, i) => s != null && s >= high[i]);

  // 信号点
  const 多方上穿 = CROSS(多方力度, 多方力度.map(() => 6.78)); // 多方力度上穿 6.78
  const rsiDown = CROSS(RSI.map(() => 88.8), RSI);          // 88.8 上穿 RSI = RSI 跌破 88.8
  const 持币信号 = 持币.map((v, i) => v && (!持股[i]));

  return {
    cats: minute.map((d) => d.t),
    空方力度, 多方力度, RSI, 主力吸筹: 主力吸筹C,
    持股, 持币,
    signals: { 多方上穿, rsiDown, var5: VAR5, var6: VAR6, 持币信号 },
  };
}
