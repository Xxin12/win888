'use strict';
/**
 * 数据接口实测脚本 —— 逐个真实调用所有 provider，确认返回数据的范围/条数/字段/锚定日期。
 * 目的: 为「数据来源配置页面」提供经过验证的能力上限, 避免错误配置。
 *
 * 用法: node server/scripts/test_providers.js [code]
 *   默认 code = sz002027 (分众传媒)
 */
const tencent = require('../server/providers/tencent');
const sina = require('../server/providers/sina');
const emDay = require('../server/providers/eastmoney_day');
const emIntraday = require('../server/providers/eastmoney_intraday');
const tdx = require('../server/providers/tdx_intraday');

const CODE = process.argv[2] || 'sz002027';

function range(bars, keyFn) {
  if (!bars || !bars.length) return { n: 0 };
  const ks = bars.map(keyFn).filter(Boolean).sort();
  return { n: bars.length, first: ks[0], last: ks[ks.length - 1] };
}
function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }
function line(name, ok, detail) {
  console.log(`${ok ? 'OK ' : 'ERR'} | ${pad(name, 26)} | ${detail}`);
}

async function timed(fn) {
  const t0 = Date.now();
  try { const v = await fn(); return { v, ms: Date.now() - t0 }; }
  catch (e) { return { err: e.message, ms: Date.now() - t0 }; }
}

(async () => {
  console.log('='.repeat(90));
  console.log(`数据接口实测  code=${CODE}  ${new Date().toISOString()}`);
  console.log('='.repeat(90));

  // 1) 腾讯 实时报价
  {
    const { v, err, ms } = await timed(() => tencent.getQuotes([CODE]));
    if (err) line('腾讯 实时报价', false, err);
    else {
      const q = v[0] || {};
      line('腾讯 实时报价', !!v.length, `${ms}ms  name=${q.name} price=${q.price} time=${q.time} 字段=${Object.keys(q).length}项`);
    }
  }

  // 2) 腾讯 日K (尝试请求 1000 根, 看实际返回上限)
  {
    const { v, err, ms } = await timed(() => tencent.getDayKline(CODE, 1000));
    if (err) line('腾讯 日K(请求1000)', false, err);
    else { const r = range(v, (b) => b.date); line('腾讯 日K(请求1000)', r.n > 0, `${ms}ms  实返=${r.n}根  ${r.first}~${r.last}  字段:date,ohlc,volume`); }
  }

  // 3) 腾讯 5分钟 (尝试请求 2000 根, 看实际上限)
  {
    const { v, err, ms } = await timed(() => tencent.get5minKline(CODE, 2000));
    if (err) line('腾讯 5分钟(请求2000)', false, err);
    else { const r = range(v, (b) => b.datetime); line('腾讯 5分钟(请求2000)', r.n > 0, `${ms}ms  实返=${r.n}根  ${r.first}~${r.last}`); }
  }

  // 4) 腾讯 当日分时
  {
    const { v, err, ms } = await timed(() => tencent.getMinute(CODE));
    if (err) line('腾讯 当日分时', false, err);
    else { const r = range(v, (b) => b.t); line('腾讯 当日分时', r.n > 0, `${ms}ms  实返=${r.n}点  ${r.first}~${r.last}  字段:t,price,avg,volume,cumVolume`); }
  }

  // 5) 新浪 5分钟 (请求上限 5001)
  {
    const { v, err, ms } = await timed(() => sina.get5minKline(CODE, 5001));
    if (err) line('新浪 5分钟(请求5001)', false, err);
    else {
      const r = range(v, (b) => b.datetime);
      const days = v && v.length ? new Set(v.map((b) => b.date)).size : 0;
      line('新浪 5分钟(请求5001)', r.n > 0, `${ms}ms  实返=${r.n}根 ≈${days}个交易日  ${r.first}~${r.last}`);
    }
  }
  // 5b) 新浪 5分钟 常用视图档 datalen=1300
  {
    const { v, err, ms } = await timed(() => sina.get5minKline(CODE, 1300));
    if (err) line('新浪 5分钟(请求1300)', false, err);
    else { const r = range(v, (b) => b.datetime); const days = v.length ? new Set(v.map((b) => b.date)).size : 0; line('新浪 5分钟(请求1300)', r.n > 0, `${ms}ms  实返=${r.n}根 ≈${days}交易日  ${r.first}~${r.last}`); }
  }

  // 6) 东财 日K (回溯多年: beg=20180101)
  {
    const { v, err, ms } = await timed(() => emDay.getDayKline(CODE, { beg: '20180101', end: '20500101', lmt: 3000 }));
    if (err) line('东财 日K(2018至今)', false, err);
    else { const r = range(v, (b) => b.date); line('东财 日K(2018至今)', r.n > 0, `${ms}ms  实返=${r.n}根  ${r.first}~${r.last}  字段:+amount,turnover,amplitude,pct`); }
  }

  // 7) 东财 历史分时 (请求 5 天 / 尝试 30 天看是否被截)
  {
    const { v, err, ms } = await timed(() => emIntraday.getIntradayRange(CODE, { days: 5 }));
    if (err) line('东财 历史分时(请求5)', false, err);
    else line('东财 历史分时(请求5)', v.points > 0, `${ms}ms  实返=${v.dates.length}交易日 ${v.points}点  日期=${v.dates.join(',')}  capped=${v.capped}`);
  }
  {
    const { v, err, ms } = await timed(() => emIntraday.getIntradayRange(CODE, { days: 30 }));
    if (err) line('东财 历史分时(请求30)', false, err);
    else line('东财 历史分时(请求30)', v.points > 0, `${ms}ms  实返=${v.dates.length}交易日 ${v.points}点  capped=${v.capped}(→实际上限)`);
  }

  // 8) TDX 分时 (取决于 TDX_ENDPOINT / 网关是否运行)
  {
    line('TDX 分时 available()', tdx.available(), tdx.available() ? ('端点=' + (process.env.TDX_ENDPOINT || '')) : tdx.unavailableReason());
    if (tdx.available()) {
      const { v, err, ms } = await timed(() => tdx.getIntradayRange(CODE, { days: 5 }));
      if (err) line('TDX 分时(请求5)', false, err);
      else if (v.degraded) line('TDX 分时(请求5)', false, '降级: ' + v.reason);
      else line('TDX 分时(请求5)', v.points > 0, `${ms}ms  实返=${v.dates.length}交易日 ${v.points}点  capped=${v.capped}`);
    }
  }

  console.log('='.repeat(90));
  console.log('说明: 5分钟/日K 若首根锚定"今天"倒推, 则历史深度=实返根数; 分时源锚定最近N交易日。');
})();
