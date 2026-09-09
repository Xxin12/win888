'use strict';
// 全量实测：对全部 15 个大盘指数跑 分时/5分/日线 回补(走真实队列), 完成后校验覆盖与数据正确性
const http = require('http');
function req(method, path, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: 5178, path, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
      (resp) => { let d = ''; resp.on('data', (c) => (d += c)); resp.on('end', () => { try { res(JSON.parse(d)); } catch (e) { res({ raw: d }); } }); });
    if (data) r.write(data); r.on('error', rej); r.end();
  });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
(async () => {
  // 1) 取全部指数代码
  const idx = await req('GET', '/api/indices');
  const codes = idx.indices.map((x) => x.code);
  console.log('指数总数:', codes.length, codes.join(','));

  // 2) 对每类发起回补(显式 codes = 全部指数), 进统一队列
  for (const t of ['intraday', '5min', 'day']) {
    const r = await req('POST', '/api/backfill-bulk', { type: t, codes, force: true });
    console.log(`触发 ${t}:`, JSON.stringify(r));
  }

  // 3) 轮询直到队列空且无运行任务
  let last = '';
  for (let i = 0; i < 120; i++) {
    const st = await req('GET', '/api/backfill-bulk/status');
    const running = (st.jobs || []).filter((j) => !j.finished).length;
    const q = st.queueLength || 0;
    const line = `poll ${i}: running=${running} queue=${q}`;
    if (line !== last) { console.log(line); last = line; }
    if (running === 0 && q === 0) { console.log('>>> 全部完成 (轮询 ' + i + ')'); break; }
    await sleep(3000);
  }

  // 4) 校验覆盖
  const after = await req('GET', '/api/indices');
  console.log('\n=== 回补后覆盖 ===');
  let okAll = true;
  for (const x of after.indices) {
    const row = `${x.code.padEnd(9)} ${x.name.padEnd(6)} intraday=${x.intradayDates}天 day=${x.hasDay ? 'Y' : 'N'} 5min=${x.has5min ? 'Y' : 'N'}`;
    if (!(x.intradayDates > 0 && x.hasDay && x.has5min)) { okAll = false; console.log('  [缺] ' + row); }
    else console.log('  [OK] ' + row);
  }
  console.log('\n全量覆盖达标:', okAll ? 'YES' : 'NO');

  // 5) 数据正确性抽样(直接读 marketStore)
  const ms = require('/c/Users/miao/Desktop/W888/quant-web/server/lib/marketStore.js');
  console.log('\n=== 数据抽样(末根/日期) ===');
  for (const c of codes) {
    const day = ms.getDayBars(c); const m5 = ms.get5minBars(c); const idates = ms.listIntradayDates(c);
    const dLast = day.length ? day[day.length - 1] : null;
    const mLast = m5.length ? m5[m5.length - 1] : null;
    console.log(
      c.padEnd(9),
      'day:', String(day.length).padStart(5), dLast ? ('末' + dLast.date + '收' + dLast.close) : '-',
      '| 5m:', String(m5.length).padStart(5), mLast ? ('末' + (mLast.datetime || mLast.date)) : '-',
      '| 分时日:', idates.length
    );
  }
})().catch((e) => console.log('FATAL', e.message));
