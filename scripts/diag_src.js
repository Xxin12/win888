'use strict';
const tencent = require('../server/providers/tencent');
const eastmoney = require('../server/providers/eastmoney_intraday');
const { secidOf } = require('../server/providers/eastmoney_day');
const { DatabaseSync } = require('node:sqlite');
const code = 'sh000001';
(async () => {
  console.log('=== secidOf(sh000001) ===', secidOf(code));
  // 1) 腾讯
  try {
    const rows = await tencent.getMinute(code);
    console.log('=== 腾讯 getMinute 行数:', rows.length);
    console.log('   首行:', JSON.stringify(rows[0]));
    console.log('   末行:', JSON.stringify(rows[rows.length-1]));
  } catch (e) { console.log('腾讯 getMinute 抛错:', e.message); }
  // 2) 东财 trends2
  try {
    const res = await eastmoney.getIntradayRange(code, { days: 5 });
    console.log('=== 东财 getIntradayRange degraded:', res.degraded, 'reason:', res.reason);
    console.log('   日期列表:', JSON.stringify(res.dates));
    let sample = null;
    if (res.byDate) { for (const d of res.dates) { sample = (res.byDate[d]||[])[0]; if (sample) { console.log('   样本日期', d, '首行:', JSON.stringify(sample)); break; } } }
  } catch (e) { console.log('东财 getIntradayRange 抛错:', e.message); }
})();
