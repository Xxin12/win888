// 验证「下跌才买入」门控：对比 fixed 与 downtick 两种买入规则
const fs = require('fs');
const { runDca } = require('../server/backtest/dca');

const CSV = 'E:\\W888\\分众传媒_002027_日线_截至20260803.csv';
const text = fs.readFileSync(CSV, 'utf8');
const lines = text.replace(/^﻿/, '').replace(/\r/g, '').split('\n').filter(Boolean);
const head = lines[0].split(',');
const col = (name) => head.findIndex((h) => h.includes(name));
const ci = { date: (head.findIndex((h) => h.includes('时间') || h.includes('日期'))), open: col('开盘'), high: col('最高'), low: col('最低'), close: col('收盘'), vol: col('成交量') };
const num = (s) => { const v = parseFloat(String(s).replace(/,/g, '').replace(/%/g, '')); return isNaN(v) ? 0 : v; };
const bars = lines.slice(1).map((l) => { const f = l.split(','); return { date: f[ci.date], open: num(f[ci.open]), high: num(f[ci.high]), low: num(f[ci.low]), close: num(f[ci.close]), volume: num(f[ci.vol]) }; });

function run(rule) {
  const p = { code: 'sz002027', bars, params: { freq: 'monthly', amount: 5000, buyRule: rule } };
  const r = runDca(p);
  if (!r.ok) { console.log(rule, 'FAIL', r.error); return null; }
  const m = r.metrics;
  console.log(`[${rule}] 期数=${m.periods} 上涨跳过=${m.downtick_skips || 0} 投入=${Math.round(m.invested)} 收益=${m.return_pct}% XIRR=${m.xirr}% 回撤=${m.mdd_pct}% 手续费=${m.fee}`);
  return r;
}

const fixed = run('fixed');
const down = run('downtick');

if (fixed && down) {
  console.log('\n断言:');
  console.log('  downtick 期数 <= fixed 期数 :', down.metrics.periods <= fixed.metrics.periods ? 'OK' : 'FAIL');
  console.log('  downtick 上涨跳过 > 0        :', (down.metrics.downtick_skips || 0) > 0 ? 'OK' : 'FAIL');
  console.log('  fixed 无上涨跳过             :', (fixed.metrics.downtick_skips || 0) === 0 ? 'OK' : 'FAIL');
  // 抽查: downtick 的每一笔买入当日收盘应 < 前一日收盘
  const idxByDate = {}; bars.forEach((b, i) => { idxByDate[b.date] = i; });
  let bad = 0;
  down.trades.filter((t) => t.type === 'buy').forEach((t) => {
    const i = idxByDate[t.date];
    if (i > 0 && !(bars[i].close < bars[i - 1].close)) bad++;
  });
  console.log('  downtick 每笔买入均为下跌日  :', bad === 0 ? 'OK' : `FAIL(${bad} 笔非下跌日)`);
}
