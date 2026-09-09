'use strict';
/**
 * 腾讯自选股公开接口 Provider (后端直连)
 * - 实时报价: https://qt.gtimg.cn/q=<code>   (GBK, ~ 分隔)
 * - 日K:      https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=<code>,day,,,N,qfq
 * - 分时:     https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=<code>
 * - 5分钟:    https://web.ifzq.gtimg.cn/appstock/app/kline/mkline?param=<code>,m5,,N
 */

const decoder = new TextDecoder('gbk');

function normCode(code) {
  code = String(code).toLowerCase().trim();
  if (/^(sh|sz|bj)\d{6}$/.test(code)) return code;
  if (/^\d{6}$/.test(code)) {
    if (code[0] === '6') return 'sh' + code;
    if (code[0] === '8' || code[0] === '4') return 'bj' + code;
    return 'sz' + code;
  }
  return code;
}

async function fetchWithTimeout(url, opts = {}, ms = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** 解析单条 qt.gtimg.cn 行情字符串 */
function parseQuote(raw) {
  // v_sz002027="51~分众传媒~002027~4.75~4.81~4.79~..."
  const m = raw.match(/="([^"]*)"/);
  if (!m) return null;
  const f = m[1].split('~');
  if (f.length < 40) return null;
  const num = (i) => parseFloat(f[i]);
  return {
    code: normCode(f[2]),
    name: f[1],
    status: f[40] || '', // 证券状态位: 'D'=退市/停牌(非活跃); 正常股为空
    price: num(3),
    preclose: num(4),
    open: num(5),
    volume: num(6), // 手
    time: f[30],
    change: num(31),
    change_pct: num(32),
    high: num(33),
    low: num(34),
    turnover: num(38), // 换手率%
    pe: num(39),
    amount: num(37), // 成交额(万)
    market_cap: num(45), // 总市值(亿)
    float_cap: num(44), // 流通市值(亿)
  };
}

/** 批量实时报价 */
async function getQuotes(codes) {
  const list = codes.map(normCode);
  const url = 'https://qt.gtimg.cn/q=' + list.join(',');
  const r = await fetchWithTimeout(url);
  const buf = await r.arrayBuffer();
  const text = decoder.decode(buf);
  const out = [];
  text.split(';').forEach((line) => {
    line = line.trim();
    if (!line.startsWith('v_')) return;
    const q = parseQuote(line);
    if (q) out.push(q);
  });
  return out;
}

/** 日K线 -> [{date,open,high,low,close,volume}] */
async function getDayKline(code, count = 320) {
  const c = normCode(code);
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${c},day,,,${count},qfq`;
  const r = await fetchWithTimeout(url);
  const j = await r.json();
  const node = j?.data?.[c];
  const arr = node?.qfqday || node?.day || [];
  return arr.map((row) => ({
    date: row[0],
    open: parseFloat(row[1]),
    close: parseFloat(row[2]),
    high: parseFloat(row[3]),
    low: parseFloat(row[4]),
    volume: parseFloat(row[5]),
  }));
}

/** 5分钟K线 -> fzme格式 [{datetime,date,open,high,low,close,volume,amount}]
 *  注意：旧 host web.ifzq.gtimg.cn 现已 301 跳转到 web3(ifzq) 且不可达，
 *  改用 proxy.finance.qq.com/ifzqgtimg 作为主数据源，旧 host 仅作兜底。
 */
const M5_ENDPOINTS = [
  'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/kline/mkline',
  'https://web.ifzq.gtimg.cn/appstock/app/kline/mkline',
];
async function get5minKline(code, count = 320) {
  const c = normCode(code);
  let lastErr = null;
  for (const base of M5_ENDPOINTS) {
    try {
      const url = `${base}?param=${c},m5,,${count}`;
      const r = await fetchWithTimeout(url);
      const j = await r.json();
      const node = j?.data?.[c];
      const arr = node?.m5 || node?.qfqm5 || [];
      if (!arr.length) continue; // 该源无数据, 试下一个
      return arr.map((row) => {
        // ["202607131000", open, close, high, low, volume, {}, amount]
        const ts = String(row[0]);
        const dt = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ${ts.slice(8, 10)}:${ts.slice(10, 12)}:00`;
        return {
          datetime: dt,
          date: ts.slice(0, 8),
          open: parseFloat(row[1]),
          close: parseFloat(row[2]),
          high: parseFloat(row[3]),
          low: parseFloat(row[4]),
          volume: parseFloat(row[5]),
          amount: parseFloat(row[7]) || 0,
        };
      });
    } catch (e) { lastErr = e; }
  }
  if (lastErr) throw lastErr;
  return [];
}

/**
 * 是否属于 A 股正常交易时段(集合竞价开盘 09:25 ~ 上午 11:30, 下午 13:00 ~ 收盘 15:00)。
 * 腾讯分时接口在收盘后会用"最后价"把序列补齐到 15:30(甚至夹带盘后固定价格交易的零星成交),
 * 这些 15:01~15:30 的幽灵分钟会让分时图尾盘出现一段多余的水平线, 且把"收盘点"错误地
 * 拖到 15:30, 导致看盘页当日分时的收盘价格与实际收盘价格/走势不符。此处按时段裁剪修复。
 */
function inTradingSession(hhmm) {
  return (hhmm >= '09:25' && hhmm <= '11:30') || (hhmm >= '13:00' && hhmm <= '15:00');
}

/** 当日分时 -> [{t:'HH:MM',price,avg,volume(分时量/每分钟),cumVolume(累计)}] */
async function getMinute(code) {
  const c = normCode(code);
  const url = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${c}`;
  const r = await fetchWithTimeout(url);
  const j = await r.json();
  const node = j?.data?.[c]?.data;
  const arr = node?.data || [];
  const preclose = parseFloat(node?.qt?.[c]?.[4] || 0) || null;
  let prevCum = 0, cumAmount = 0;
  const out = [];
  for (const s of arr) {
    // "0930 4.79 4833 2315007.00"  = time price cumVol(手) amount
    const p = s.split(/\s+/);
    const time = `${p[0].slice(0, 2)}:${p[0].slice(2, 4)}`;
    // 裁剪盘后幽灵分钟(15:01~15:30 等): 保留至真实收盘 15:00, 使尾盘收盘价与实际一致
    if (!inTradingSession(time)) continue;
    const price = parseFloat(p[1]);
    const cumVol = parseFloat(p[2]);   // 累计成交量(手)
    const amt = parseFloat(p[3]);
    const vol = +(cumVol - prevCum).toFixed(2);  // 分时量(每分钟增量), 首根=开盘量
    prevCum = cumVol;
    cumAmount = amt;
    const avg = cumVol > 0 ? +(cumAmount / (cumVol * 100)).toFixed(3) : price;
    out.push({ t: time, price, avg, volume: vol, cumVolume: cumVol });
  }
  return out;
}

module.exports = { normCode, getQuotes, getDayKline, get5minKline, getMinute };
