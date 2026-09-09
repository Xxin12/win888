'use strict';
const tdx = require('../server/providers/tdx_intraday');
const { secidOf } = require('../server/providers/eastmoney_day');
(async () => {
  console.log('=== tdx.available() ===', typeof tdx.available==='function' ? tdx.available() : 'n/a');
  // 直接调 tdx 接口看原始返回
  try {
    const res = await tdx.getIntradayRange('sh000001', {days:5});
    console.log('=== tdx.getIntradayRange sh000001 ===');
    console.log('  degraded:', res.degraded, 'reason:', res.reason);
    console.log('  dates:', JSON.stringify(res.dates));
    let n=0;
    if(res.byDate){for(const d of res.dates){const rows=res.byDate[d]||[];if(rows.length){console.log('  日期',d,'首行:',JSON.stringify(rows[0]),'末行:',JSON.stringify(rows[rows.length-1]));n++;if(n>=2)break;}}}
  } catch (e) { console.log('  tdx 抛错:', e.message); }
})();
