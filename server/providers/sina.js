'use strict';
/**
 * 新浪 5分钟K线 Provider (后端直连)
 * 优势: 历史跨度大, 单次上限约 5001 根(≈104 交易日 ≈ 5 个月), 远超腾讯(480)/东财(1500)。
 *   endpoint: https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData
 *   参数: symbol=<sh/sz/bj+代码>, scale=5(5分钟), ma=no, datalen=<根数>
 *   返回: [{day:"2026-03-11 13:45:00", open, high, low, close, volume}, ...]  (时间升序)
 *
 * 用途:
 *   - 实时看盘 5分钟K线: datalen≈1300 -> 约一个月视图
 *   - 回测自动抓取: datalen=5001 -> 尽可能长的历史(回测窗口内的数据)
 */
const { normCode } = require('./tencent');

async function fetchWithTimeout(url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

/** 容错解析: 兼容裸 JSON / var x = [...] / (...) 包裹 */
function parseSina(text) {
  let t = String(text).trim();
  if (!t || t === 'null') return [];
  if (/^var\s+\w+\s*=/.test(t)) t = t.replace(/^var\s+\w+\s*=\s*/, '');
  if (t.endsWith(';')) t = t.slice(0, -1).trim();
  if (t.startsWith('(') && t.endsWith(')')) t = t.slice(1, -1).trim();
  if (!t) return [];
  try { const v = JSON.parse(t); return Array.isArray(v) ? v : []; }
  catch (_) { return []; }
}

/**
 * 获取5分钟K线(新浪历史)
 * @param {string} code 标准代码
 * @param {number} datalen 请求根数(上限约5001)
 * @returns {Promise<Array>} fzme格式 bars (时间升序)
 */
async function get5minKline(code, datalen = 5001) {
  const sym = normCode(code); // sh600036 / sz000001 / bj8xxxxx
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${sym}&scale=5&ma=no&datalen=${datalen}`;
  const r = await fetchWithTimeout(url);
  const txt = await r.text();
  const arr = parseSina(txt);
  if (!arr.length) return [];
  return arr.map((o) => {
    const dt = o.day; // "2026-03-11 13:45:00"
    const [datePart] = dt.split(' ');
    return {
      datetime: dt,
      date: datePart,
      open: parseFloat(o.open),
      close: parseFloat(o.close),
      high: parseFloat(o.high),
      low: parseFloat(o.low),
      volume: parseFloat(o.volume) || 0,
      amount: 0,
    };
  });
}

/**
 * 获取日K线(新浪历史, scale=240=日线)
 * 实测: datalen≤5001 实返 5001 根 ≈20 年(免费最深日K源); 字段 date,OHLC,volume(无成交额)。
 * 注意: 新浪日K day 字段为纯日期("2005-05-13"), 无时间; 与腾讯/东财日K格式一致, 可正常按 date 合并。
 * @param {string} code 标准代码
 * @param {number} datalen 请求根数(上限约5001)
 * @returns {Promise<Array>} fzme 日K格式 bars (时间升序)
 */
async function getDayKline(code, datalen = 5001) {
  const sym = normCode(code);
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${sym}&scale=240&ma=no&datalen=${datalen}`;
  const r = await fetchWithTimeout(url);
  const txt = await r.text();
  const arr = parseSina(txt);
  if (!arr.length) return [];
  return arr.map((o) => {
    const dt = o.day; // "2005-05-13"
    return {
      date: dt,
      open: parseFloat(o.open),
      close: parseFloat(o.close),
      high: parseFloat(o.high),
      low: parseFloat(o.low),
      volume: parseFloat(o.volume) || 0,
      amount: 0,
    };
  });
}

module.exports = { get5minKline, getDayKline };
