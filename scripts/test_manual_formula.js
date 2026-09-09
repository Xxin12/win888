const { runManualBacktest, deriveFormula } = require('../server/backtest/manual');
const intraday = require('../server/lib/intradayRecorder');
const code = 'sz000001';

(async () => {
  const rows = intraday.loadDate(code, '2026-07-16');
  if (!rows || !rows.length) { console.error('无分时数据'); process.exit(2); }
  const buy = rows.find((r) => r.price < r.avg);
  const sell = rows.find((r) => r.price > r.avg);
  console.log('2026-07-16 棒数:', rows.length);
  console.log('买锚点:', buy && { t: buy.t, price: buy.price, avg: buy.avg });
  console.log('卖锚点:', sell && { t: sell.t, price: sell.price, avg: sell.avg });
  const marks = [
    { date: '2026-07-16', time: buy.t, price: buy.price, avg: buy.avg, type: 'buy' },
    { date: '2026-07-16', time: sell.t, price: sell.price, avg: sell.avg, type: 'sell' },
  ];
  const f = await deriveFormula(code, marks);
  console.log('推导公式:', f);
  const res = await runManualBacktest(code, 2000, marks);
  console.log('回测 ok:', res.ok, '| 交易笔数:', res.trades.length, '| 评估日:', res.evaluated, '/', res.totalDates, '| 触发日:', res.tradeDays, '| 跳过:', res.skipped);
  if (res.ok && res.trades.length) {
    console.log('首笔交易:', JSON.stringify(res.trades[0]));
    console.log('末笔交易:', JSON.stringify(res.trades[res.trades.length - 1]));
  } else {
    console.log('回测返回:', JSON.stringify(res));
  }
})().catch((e) => { console.error('ERR', e); process.exit(1); });
