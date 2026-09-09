const BASE = 'http://localhost:5178';
const code = 'sz000001';
const date = '2026-07-16';
(async () => {
  const day = await (await fetch(`${BASE}/api/backtest/day?code=${code}&date=${date}`)).json();
  if (!day.ok || !day.data.length) { console.error('no day data'); process.exit(2); }
  const rows = day.data;
  const buy = rows.find((r) => r.price < r.avg);
  const sell = rows.find((r) => r.price > r.avg);
  console.log('锚点 买:', buy && { t: buy.t, price: buy.price, avg: buy.avg }, '| 卖:', sell && { t: sell.t, price: sell.price, avg: sell.avg });
  const marks = [
    { date, time: buy.t, price: buy.price, avg: buy.avg, type: 'buy' },
    { date, time: sell.t, price: sell.price, avg: sell.avg, type: 'sell' },
  ];
  const r = await (await fetch(`${BASE}/api/backtest`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, strategy: 'manual', qty: 2000, marks }),
  })).json();
  console.log('ok:', r.ok, '| strategy:', r.strategy);
  console.log('formula:', JSON.stringify(r.formula));
  console.log('meta:', JSON.stringify(r.meta));
  if (r.metrics) console.log('metrics:', JSON.stringify({ net: r.metrics.net, win_rate: r.metrics.win_rate, days: r.metrics.days, mdd: r.metrics.mdd, sharpe: r.metrics.sharpe }));
  if (r.trades) {
    console.log('交易笔数:', r.trades.length);
    console.log('示例(首/末):', JSON.stringify(r.trades[0]), JSON.stringify(r.trades[r.trades.length - 1]));
    const dates = [...new Set(r.trades.map((t) => t.date))];
    console.log('覆盖日期数:', dates.length, '| 样例日期:', dates.slice(0, 3), '...', dates.slice(-3));
  } else { console.log('返回:', JSON.stringify(r)); }
})().catch((e) => { console.error('ERR', e); process.exit(1); });
