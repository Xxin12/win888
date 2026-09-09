'use strict';
/**
 * 数据源实测探测 (server/lib/dataSourceProbe.js)
 * ------------------------------------------------------------------
 * 逐个真实调用各 provider，返回结构化的「实测结果」(条数/日期范围/交易日数/耗时/字段/错误),
 * 供配置页「测试全部接口」按钮调用，让用户在自己机器上确认真实数据范围，避免错误配置。
 * 说明: 东财 push2his 在部分受限网络(如某些沙箱)会 UND_ERR_SOCKET，属环境网络问题；
 *       本探测会如实返回该错误，用户本机通常可正常访问。
 */
const tencent = require('../providers/tencent');
const sina = require('../providers/sina');
const emDay = require('../providers/eastmoney_day');
const emIntraday = require('../providers/eastmoney_intraday');
const tdx = require('../providers/tdx_intraday');
const stockUniverse = require('../lib/stockUniverse');

async function timed(fn) {
  const t0 = Date.now();
  try { return { v: await fn(), ms: Date.now() - t0 }; }
  catch (e) { return { err: e.message, ms: Date.now() - t0 }; }
}
function rng(bars, keyFn) {
  if (!bars || !bars.length) return { n: 0 };
  const ks = bars.map(keyFn).filter(Boolean).sort();
  return { n: bars.length, first: ks[0], last: ks[ks.length - 1] };
}
function tradingDays(bars) { return bars && bars.length ? new Set(bars.map((b) => b.date)).size : 0; }

/**
 * 探测所有数据源
 * @param {string} code 标准代码 sh/sz/bj+6位
 * @returns {Promise<Array<{type,typeLabel,source,sourceName,ok,detail,n,first,last,days,ms,error}>>}
 */
async function probeAll(code = 'sz002027') {
  const out = [];
  const push = (o) => out.push(o);

  // ---- 实时报价 / 腾讯 ----
  {
    const { v, err, ms } = await timed(() => tencent.getQuotes([code]));
    const q = (v && v[0]) || null;
    push({
      type: 'quote', typeLabel: '实时报价', source: 'tencent', sourceName: '腾讯自选股',
      ok: !!q, ms, n: q ? 1 : 0, first: null, last: q ? q.time : null, days: null,
      detail: q ? `${q.name} 价=${q.price} 时间=${q.time}` : '无数据', error: err || null,
    });
  }

  // ---- 日K / 腾讯(请求800安全档) ----
  {
    const { v, err, ms } = await timed(() => tencent.getDayKline(code, 800));
    const r = rng(v, (b) => b.date);
    push({
      type: 'day', typeLabel: '日K线', source: 'tencent', sourceName: '腾讯 fqkline',
      ok: r.n > 0, ms, n: r.n, first: r.first, last: r.last, days: r.n,
      detail: r.n ? `${r.n}根 ${r.first}~${r.last}` : '无数据', error: err || null,
    });
  }
  // ---- 日K / 东财(回溯多年) ----
  {
    const beg = (() => { const d = new Date(); d.setFullYear(d.getFullYear() - 5); return d.toISOString().slice(0, 10).replace(/-/g, ''); })();
    const { v, err, ms } = await timed(() => emDay.getDayKline(code, { beg, end: '20500101', lmt: 3000 }));
    const r = rng(v, (b) => b.date);
    const hasExtra = v && v[0] && ('turnover' in v[0]);
    push({
      type: 'day', typeLabel: '日K线', source: 'eastmoney', sourceName: '东财 kline',
      ok: r.n > 0, ms, n: r.n, first: r.first, last: r.last, days: r.n,
      detail: r.n ? `${r.n}根 ${r.first}~${r.last}${hasExtra ? ' (+换手/振幅/额)' : ''}` : '无数据(近5年请求)',
      error: err || null,
    });
  }

  // ---- 日K / 新浪(scale=240, ≈20年) ----
  {
    const { v, err, ms } = await timed(() => sina.getDayKline(code, 5001));
    const r = rng(v, (b) => b.date);
    push({
      type: 'day', typeLabel: '日K线', source: 'sina', sourceName: '新浪 scale=240',
      ok: r.n > 0, ms, n: r.n, first: r.first, last: r.last, days: r.n,
      detail: r.n ? `${r.n}根 ${r.first}~${r.last} (≈${(r.n / 242 | 0)}年)` : '无数据', error: err || null,
    });
  }
  // ---- 日K / TDX 网关(category=4) ----
  {
    if (!tdx.available()) {
      push({
        type: 'day', typeLabel: '日K线', source: 'tdx', sourceName: '通达信网关(pytdx)',
        ok: false, ms: 0, n: 0, first: null, last: null, days: 0,
        detail: '未部署(TDX_ENDPOINT 未配置)', error: '网关未启动，请在「TDX 网关」页启动后再测。',
      });
    } else {
      const { v, err, ms } = await timed(() => tdx.getDayKline(code, { datalen: 5001 }));
      const degraded = v && v.degraded;
      const ok = Array.isArray(v) && v.length > 0;
      push({
        type: 'day', typeLabel: '日K线', source: 'tdx', sourceName: '通达信网关(pytdx)',
        ok, ms, n: ok ? v.length : 0, first: ok ? v[0].date : null, last: ok ? v[v.length - 1].date : null,
        days: ok ? v.length : 0,
        detail: degraded ? ('降级: ' + v.reason) : (ok ? `${v.length}根 ${v[0].date}~${v[v.length - 1].date}` : '无数据'),
        error: err || (degraded ? v.reason : null),
      });
    }
  }
  // ---- 5分钟 / 新浪(5001) ----
  {
    const { v, err, ms } = await timed(() => sina.get5minKline(code, 5001));
    const r = rng(v, (b) => b.datetime);
    push({
      type: 'min5', typeLabel: '5分钟K线', source: 'sina', sourceName: '新浪 getKLineData',
      ok: r.n > 0, ms, n: r.n, first: r.first, last: r.last, days: tradingDays(v),
      detail: r.n ? `${r.n}根 ≈${tradingDays(v)}交易日 ${r.first}~${r.last}` : '无数据', error: err || null,
    });
  }
  // ---- 5分钟 / 腾讯(480安全档) ----
  {
    const { v, err, ms } = await timed(() => tencent.get5minKline(code, 480));
    const r = rng(v, (b) => b.datetime);
    push({
      type: 'min5', typeLabel: '5分钟K线', source: 'tencent', sourceName: '腾讯 mkline',
      ok: r.n > 0, ms, n: r.n, first: r.first, last: r.last, days: tradingDays(v),
      detail: r.n ? `${r.n}根 ≈${tradingDays(v)}交易日 ${r.first}~${r.last}` : '无数据', error: err || null,
    });
  }
  // ---- 5分钟 / 东财(klt=5, 多年) ----
  {
    const { v, err, ms } = await timed(() => emDay.get5minKline(code, { datalen: 5001 }));
    const r = rng(v, (b) => b.datetime);
    push({
      type: 'min5', typeLabel: '5分钟K线', source: 'eastmoney', sourceName: '东财 klt=5',
      ok: r.n > 0, ms, n: r.n, first: r.first, last: r.last, days: tradingDays(v),
      detail: r.n ? `${r.n}根 ≈${tradingDays(v)}交易日 ${r.first}~${r.last}` : '无数据(push2his受限)', error: err || null,
    });
  }
  // ---- 5分钟 / TDX 网关(category=0) ----
  {
    if (!tdx.available()) {
      push({
        type: 'min5', typeLabel: '5分钟K线', source: 'tdx', sourceName: '通达信网关(pytdx)',
        ok: false, ms: 0, n: 0, first: null, last: null, days: 0,
        detail: '未部署(TDX_ENDPOINT 未配置)', error: '网关未启动，请在「TDX 网关」页启动后再测。',
      });
    } else {
      const { v, err, ms } = await timed(() => tdx.get5minKline(code, { datalen: 5001 }));
      const degraded = v && v.degraded;
      const ok = Array.isArray(v) && v.length > 0;
      push({
        type: 'min5', typeLabel: '5分钟K线', source: 'tdx', sourceName: '通达信网关(pytdx)',
        ok, ms, n: ok ? v.length : 0, first: ok ? v[0].datetime : null, last: ok ? v[v.length - 1].datetime : null,
        days: ok ? tradingDays(v) : 0,
        detail: degraded ? ('降级: ' + v.reason) : (ok ? `${v.length}根 ≈${tradingDays(v)}交易日` : '无数据'),
        error: err || (degraded ? v.reason : null),
      });
    }
  }

  // ---- 当日分时(live) / 腾讯 ----
  {
    const { v, err, ms } = await timed(() => tencent.getMinute(code));
    const r = rng(v, (b) => b.t);
    push({
      type: 'intradayLive', typeLabel: '当日分时(实时)', source: 'tencent', sourceName: '腾讯 minute/query',
      ok: r.n > 0, ms, n: r.n, first: r.first, last: r.last, days: 1,
      detail: r.n ? `${r.n}点 ${r.first}~${r.last}` : '无数据(非交易日/未开盘)', error: err || null,
    });
  }

  // ---- 历史分时回补 / 东财(请求5) ----
  {
    const { v, err, ms } = await timed(() => emIntraday.getIntradayRange(code, { days: 5 }));
    const ok = v && v.points > 0;
    push({
      type: 'intradayBackfill', typeLabel: '历史分时回补', source: 'eastmoney', sourceName: '东财 trends2',
      ok, ms, n: v ? v.points : 0, first: v && v.dates.length ? v.dates[v.dates.length - 1] : null,
      last: v && v.dates.length ? v.dates[0] : null, days: v ? v.dates.length : 0,
      detail: ok ? `${v.dates.length}交易日 ${v.points}点 [${v.dates.join(',')}]` : '无数据/受限', error: err || null,
    });
  }
  // ---- 历史分时回补 / TDX(网关) ----
  {
    if (!tdx.available()) {
      push({
        type: 'intradayBackfill', typeLabel: '历史分时回补', source: 'tdx', sourceName: '通达信网关(pytdx)',
        ok: false, ms: 0, n: 0, first: null, last: null, days: 0,
        detail: '未部署(TDX_ENDPOINT 未配置)', error: '网关未启动，请在「TDX 网关」页启动后再测。',
      });
    } else {
      const { v, err, ms } = await timed(() => tdx.getIntradayRange(code, { days: 5 }));
      const degraded = v && v.degraded;
      const ok = v && !degraded && v.points > 0;
      push({
        type: 'intradayBackfill', typeLabel: '历史分时回补', source: 'tdx', sourceName: '通达信网关(pytdx)',
        ok, ms, n: v ? (v.points || 0) : 0, first: v && v.dates && v.dates.length ? v.dates[v.dates.length - 1] : null,
        last: v && v.dates && v.dates.length ? v.dates[0] : null, days: v && v.dates ? v.dates.length : 0,
        detail: degraded ? ('降级: ' + v.reason) : (ok ? `${v.dates.length}交易日 ${v.points}点` : '无数据'),
        error: err || (degraded ? v.reason : null),
      });
    }
  }

  // ---- 股票池来源(universe): 按配置源展示(tdx/eastmoney/local) + 各源可达性 ----
  {
    const { v, err, ms } = await timed(() => stockUniverse.checkUniverse());
    const src = (v && v.source) || 'tdx';
    let ok = false, detail = '', error = null, n = 0;
    if (src === 'tdx') {
      ok = !!(v && v.tdxOk);
      n = v ? v.tdxCount : 0;
      detail = v && v.tdxOk ? `通达信网关枚举成功(全市场约 ${v.tdxCount} 只)` : ('通达信不可用' + (v && v.tdxError ? `(${v.tdxError})` : '') + (v && v.localCount ? `；若已有快照可回退本地(${v.localCount}只)` : ''));
      error = ok ? null : (v && v.tdxError);
    } else if (src === 'local') {
      ok = !!(v && v.localCount > 0);
      n = v ? v.localCount : 0;
      detail = v && v.localCount ? `本地快照 ${v.localCount} 只` : '本地快照缺失';
      error = ok ? null : '本地快照缺失';
    } else { // eastmoney
      ok = !!(v && (v.emOk || v.localCount > 0));
      n = v ? v.localCount : 0;
      detail = v && v.emOk ? '东财 clist 可达' : ('东财不可达' + (v && v.localCount ? `；本地快照 ${v.localCount} 只可用` : '；无本地快照'));
      error = ok ? null : (v && (v.emError || (v.localCount ? null : '东财与本地快照均不可用')));
    }
    push({
      type: 'universe', typeLabel: '股票池来源', source: src,
      sourceName: src === 'tdx' ? '通达信网关' : src === 'local' ? '本地快照' : '东财 clist',
      ok, ms, n, first: null, last: null, days: null, detail, error: err || error,
    });
  }

  return out;
}

module.exports = { probeAll };
