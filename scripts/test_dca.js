'use strict';
// 定投引擎自测: 用真实导出 CSV 跑通全流程
const fs = require('fs');
const path = require('path');
const { runDca } = require('../server/backtest/dca');

const FILE = process.argv[2] || 'E:\\W888\\分众传媒_002027_日线_截至20260803.csv';
let text = fs.readFileSync(FILE, 'utf8');
if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
const lines = text.split(/\r?\n/).filter((l) => l.trim());
const head = lines[0].split(',').map((s) => s.trim());
const idx = (kw) => head.findIndex((h) => kw.some((k) => h.includes(k)));
const ci = {
  date: idx(['时间', '日期']), open: idx(['开盘']), high: idx(['最高']),
  low: idx(['最低']), close: idx(['收盘']), volume: idx(['总手', '成交量']), amount: idx(['金额', '成交额']),
};
console.log('列映射:', JSON.stringify(ci), '表头:', head.join('|'));

const bars = [];
for (let i = 1; i < lines.length; i++) {
  const c = lines[i].split(',');
  bars.push({
    date: c[ci.date], open: c[ci.open], high: c[ci.high], low: c[ci.low],
    close: c[ci.close], volume: c[ci.volume], amount: c[ci.amount],
  });
}
console.log('原始行数:', bars.length, '首行:', JSON.stringify(bars[0]), '末行:', JSON.stringify(bars[bars.length - 1]));

function show(title, params) {
  const t = Date.now();
  const r = runDca({ code: 'sz002027', bars, params });
  const ms = Date.now() - t;
  console.log('\n===== ' + title + '  (' + ms + 'ms) =====');
  if (!r.ok) { console.log('❌', r.error); return; }
  const m = r.metrics;
  console.log('区间:', r.meta.from, '~', r.meta.to, '| 原始', r.meta.rows, '有效', r.meta.valid, '跳过', r.meta.skipped);
  console.log('警告:', r.meta.warnings.join(' / ') || '无');
  console.log('期数', m.periods, '| 投入 ¥' + m.invested.toLocaleString(), '| 持股', m.shares.toLocaleString(),
    '| 成本 ¥' + m.cost, '| 市值 ¥' + m.market_value.toLocaleString());
  console.log('盈亏 ¥' + m.profit.toLocaleString(), '| 收益率', m.return_pct + '%', '| XIRR', m.xirr + '%',
    '| 收益回撤', m.mdd_pct + 'pp', '| 最大浮亏', m.max_loss_pct + '%', '| 费用 ¥' + m.fee, '| 微笑', m.smile_index + '%');
  if (r.compare.lumpsum) console.log('对照·一次性:', r.compare.lumpsum.return_pct + '%', 'XIRR', r.compare.lumpsum.xirr + '%');
  if (r.compare.deposit) console.log('对照·储蓄  :', r.compare.deposit.return_pct + '%');
  console.log('timeline:', r.timeline.length, '/', r.meta.timeline_full, '(step ' + r.meta.timeline_step + ')',
    '| trades:', r.trades.length);
  const buys = r.timeline.filter((x) => x.buy).length;
  console.log('timeline 内买点数:', buys, '(应等于期数', m.periods + ')');
  console.log('首笔:', JSON.stringify(r.trades[0]));
  console.log('末笔:', JSON.stringify(r.trades[r.trades.length - 1]));
}

show('默认: 每月首个交易日 5000元 收盘价 100股整数倍', {});
show('每周一 2000元', { freq: 'weekly', dayOfWeek: 1, amount: 2000 });
show('近5年 每月 5000元', { start: '2021-08-03', amount: 5000 });
show('均线偏离加码 MA250', { boostMode: 'ma', maPeriod: 250 });
show('逢跌5%加倍', { boostMode: 'drop', dropPct: 5, dropMul: 2 });
show('目标收益30%止盈后重启', { takeMode: 'ret', takeValue: 30, afterTake: 'restart' });
show('每交易日 200元(买不起1手→结转)', { freq: 'daily', amount: 200 });
show('异常: 区间极短', { start: '2026-07-01' });
