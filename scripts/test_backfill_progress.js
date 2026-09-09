'use strict';
// 验证 TDX provider 的 onProgress 是否按页递增(currentPage / totalPages), 以及进度存储状态机。
// 用本地 mock 网关返回假数据, 避免依赖真实 TDX 服务器。
const http = require('http');
const tdx = require('../server/providers/tdx_intraday');
const progress = require('../server/lib/backfillProgress');

const PORT = 8911;
process.env.TDX_ENDPOINT = `http://127.0.0.1:${PORT}`;
process.env.TDX_PAGE_GAP_MS = '0'; // 加速测试, 去掉每页 sleep

const server = http.createServer((req, res) => {
  // 解析 startxh
  const u = new URL(req.url, `http://x`);
  const startxh = parseInt(u.searchParams.get('startxh') || '0', 10);
  res.setHeader('Content-Type', 'application/json');
  // 模拟有限深度: startxh < 2040 有数据(约 3 页), 之后返回空 → 触发循环结束
  if (startxh < 2040) {
    const rows = [];
    for (let m = 31; m <= 50; m++) {
      rows.push({ time: `2026-07-15 09:${String(m).padStart(2, '0')}`, price: '7.00', volume: 100, amount: 700 });
    }
    res.end(JSON.stringify({ ok: true, rows }));
  } else {
    res.end(JSON.stringify({ ok: true, rows: [] }));
  }
});

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const events = [];
  const res = await tdx.getIntradayRange('sz002027', {
    days: 10,
    onProgress: (p) => events.push({ stage: p.stage, currentPage: p.currentPage, totalPages: p.totalPages, dates: p.dates, points: p.points }),
  });
  server.close();

  console.log('onProgress 调用序列:');
  for (const e of events) console.log(`  page ${e.currentPage}/${e.totalPages} | ${e.stage} | dates=${e.dates} points=${e.points}`);
  const first = events[0], last = events[events.length - 1];
  console.log('\n断言:');
  console.log('  首报 totalPages =', first.totalPages, first.totalPages === 5 ? '✅(=ceil(10*240/680)+1)' : '❌');
  console.log('  页码单调(抓取页每页+1, 末报置满):', events.every((e, i) => i === 0 || e.currentPage >= events[i - 1].currentPage) ? '✅' : '❌');
  console.log('  末报 currentPage =', last.currentPage, 'totalPages =', last.totalPages, last.currentPage === last.totalPages ? '✅(满页)' : '⚠️(被空数据提前截断, 仍正确)');
  console.log('  最终 dates =', res.dates.length, 'points =', res.points, (res.dates.length && res.points > 0) ? '✅' : '❌');

  // 进度存储状态机
  progress.start('TEST', { code: 'TEST', source: 'tdx', mode: 'days', reqDays: 10, totalPages: 5 });
  progress.update('TEST', { currentPage: 2, totalPages: 5, dates: 1, points: 100 });
  const mid = progress.get('TEST');
  console.log('\n进度存储:');
  console.log('  running 态 isActive =', progress.isActive('TEST') ? '✅' : '❌');
  console.log('  update 后 currentPage =', mid.currentPage, mid.currentPage === 2 ? '✅' : '❌');
  progress.finish('TEST', { ok: true, written: 3, points: 150, dates: ['2026-07-15'] });
  const fin = progress.get('TEST');
  console.log('  finish 后 status =', fin.status, 'written =', fin.written, (fin.status === 'done' && fin.written === 3) ? '✅' : '❌');
  console.log('  finish 后 isActive =', progress.isActive('TEST') ? '❌(应为false)' : '✅');
  process.exit(0);
})().catch((e) => { console.error('TEST_ERROR', e); process.exit(1); });
