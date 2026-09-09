'use strict';
/**
 * 东财日K提供层 (server/providers/eastmoney_day.js)
 * 相较腾讯 fqkline(仅OHLCV), 东财日K可历史回溯多年, 且含:
 *   amount(成交额/元), turnover(换手率%), amplitude(振幅%), pct(涨跌幅%)
 * 这些是 A股短线选股规则(S00~S07)判定"放量/新高/换手"的硬依赖字段。
 * 注意: 日K不像5分钟那样锚定"今天", 可自由指定 beg/end 回溯任意历史区间。
 *
 * 主机可被「东财节点(emNode)」配置覆盖(部分网络仅 push2his 主机被拦截, 可填可用镜像)。
 */
const { emHost } = require('../lib/dataSource');

function secidOf(code) {
  code = String(code).toLowerCase().trim();
  const m = code.match(/^(sh|sz|bj)(\d{6})$/);
  if (!m) return null;
  const ex = { sh: '1', sz: '0', bj: '0' }[m[1]];
  return ex + '.' + m[2];
}

// 东财 kline/trends2 默认走 push2his; 若配置了自定义节点(emNode)则使用之
function klineHost() {
  return emHost() || 'push2his.eastmoney.com';
}

/**
 * 拉取日K
 * @param {string} code 标准代码 sh/sz/bj + 6位
 * @param {{beg?:string,end?:string,lmt?:number}} opt beg/end 形如 '20240101'
 * @returns {Promise<Array<{date,open,high,low,close,volume,amount,turnover,amplitude,pct}>>}
 */
async function getDayKline(code, { beg = '19900101', end = '20500101', lmt = 3000 } = {}) {
  const secid = secidOf(code);
  if (!secid) return [];
  const url =
    `https://${klineHost()}/api/qt/stock/kline/get?secid=${secid}` +
    `&fields1=f1,f2,f3` +
    `&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61` +
    `&klt=101&fqt=0&beg=${beg}&end=${end}&lmt=${lmt}`;
  const r = await fetch(url);
  const j = await r.json();
  const k = j?.data?.klines || [];
  return k.map((s) => {
    const p = s.split(',');
    return {
      date: p[0],
      open: parseFloat(p[1]),
      close: parseFloat(p[2]),
      high: parseFloat(p[3]),
      low: parseFloat(p[4]),
      volume: parseFloat(p[5]), // 手
      amount: parseFloat(p[6]), // 元
      amplitude: parseFloat(p[7]), // %
      pct: parseFloat(p[8]), // 涨跌幅%
      change: parseFloat(p[9]),
      turnover: parseFloat(p[10]), // 换手率%
    };
  });
}

/**
 * 拉取 5 分钟 K 线 (klt=5)
 * 与日K共用 push2his 接口, 仅 klt 不同; 字段映射完全一致。
 * @param {string} code 标准代码 sh/sz/bj + 6位
 * @param {{datalen?:number,end?:string}} opt datalen 默认5001(约5个月)
 * @returns {Promise<Array<{datetime,date,open,high,low,close,volume,amount}>>}
 */
async function get5minKline(code, { datalen = 5001, end = '20500101' } = {}) {
  const secid = secidOf(code);
  if (!secid) return [];
  const url =
    `https://${klineHost()}/api/qt/stock/kline/get?secid=${secid}` +
    `&fields1=f1,f2,f3` +
    `&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61` +
    `&klt=5&fqt=0&beg=0&end=${end}&lmt=${datalen}`;
  const r = await fetch(url);
  const j = await r.json();
  const k = j?.data?.klines || [];
  return k.map((s) => {
    const p = s.split(',');
    return {
      datetime: p[0],
      date: String(p[0]).slice(0, 10),
      open: parseFloat(p[1]),
      close: parseFloat(p[2]),
      high: parseFloat(p[3]),
      low: parseFloat(p[4]),
      volume: parseFloat(p[5]), // 手
      amount: parseFloat(p[6]), // 元
    };
  });
}

module.exports = { getDayKline, get5minKline, secidOf };
