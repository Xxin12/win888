'use strict';
// 诊断脚本：对每个大盘指数实测回补现状 + 东财 trends2 兜底可用性
const intraday = require('../server/lib/intradayRecorder');
const { loadBars } = require('../server/lib/klineService');
const dataSource = require('../server/lib/dataSource');
const { MAJOR_INDICES } = require('../server/lib/indices');

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function priceOf(arr){ if(!arr||!arr.length) return null; const last=arr[arr.length-1]; return last.price!=null?last.price:(last.close!=null?last.close:null); }
function dateOf(arr){ if(!arr||!arr.length) return null; const last=arr[arr.length-1]; return last.date||last.datetime||null; }

(async () => {
  const cfg = dataSource.readConfig();
  console.log('配置: intradayBackfill=%s day=%s min5=%s', cfg.intradayBackfill, cfg.day, cfg.min5);
  const tdx = require('../server/providers/tdx_intraday');
  console.log('TDX available=%s (endpoint=%j)', tdx.available(), process.env.TDX_ENDPOINT||'');
  console.log('');
  console.log('%-8s | %-12s | %-10s | %-10s | %-12s | %-12s | %-12s'.replace(/%/g,'%s'),
    'code','当前intraday','东财intraday','day(回补)', '5min(回补)','东财分时最后价','day最后收盘');
  for (const ix of MAJOR_INDICES) {
    const code = ix.code;
    // 1) 当前回补路径 intraday(默认源 tdx)
    let curIntra = '?';
    try { const r = await intraday.fetchAndStore(code,{days:5000,source:cfg.intradayBackfill,start:null,end:null,limiter:null}); curIntra = r.degraded?'DEGRADED':('ok days='+(r.dates?r.dates.length:'?')); }
    catch(e){ curIntra='ERR:'+e.message.slice(0,20); }
    await sleep(150);
    // 2) 东财 trends2 兜底 intraday
    let emIntra = '?';
    try { const r = await intraday.fetchAndStore(code,{days:5,source:'eastmoney',start:null,end:null,limiter:null}); emIntra = r.degraded?('DEG:'+(r.reason||'').slice(0,12)):('ok days='+(r.dates?r.dates.length:0)+' pts='+(r.points||0)); }
    catch(e){ emIntra='ERR:'+e.message.slice(0,20); }
    await sleep(150);
    // 3) day 回补(loadBars force)
    let dayR='?', dayPrice=null, dayDate=null;
    try { const r = await loadBars(code,'day',{force:true}); dayR='n='+(r.bars?r.bars.length:0)+' src='+(r.source||''); dayPrice=priceOf(r.bars); dayDate=dateOf(r.bars); }
    catch(e){ dayR='ERR:'+e.message.slice(0,20); }
    await sleep(150);
    // 4) 5min 回补(loadBars force)
    let m5R='?';
    try { const r = await loadBars(code,'5m',{force:true}); m5R='n='+(r.bars?r.bars.length:0)+' src='+(r.source||''); }
    catch(e){ m5R='ERR:'+e.message.slice(0,20); }
    await sleep(150);
    // 东财分时最后价(数据正确性)
    let emPrice='?', emDate='?';
    try { const r = await intraday.fetchAndStore(code,{days:1,source:'eastmoney',start:null,end:null,limiter:null}); if(r.dates&&r.dates.length){const d=r.dates[0];const rows=(r.byDate&&r.byDate[d])||[]; if(rows.length){emPrice=rows[rows.length-1].price; emDate=d;}} }
    catch(e){ emPrice='ERR'; }
    await sleep(150);

    console.log('%-8s | %-12s | %-10s | %-10s | %-12s | %-12s | %-12s'.replace(/%/g,'%s'),
      code, curIntra.slice(0,12), emIntra.slice(0,10), dayR.slice(0,10), m5R.slice(0,12),
      String(emPrice).slice(0,12), String(dayPrice!=null?dayPrice:'').slice(0,12));
  }
  console.log('\n— 说明：当前 intraday=DEGRADED 即"分时回补不正常"(tdx 不可达且无兜底)；东财intraday 若 ok 则说明兜底可用 —');
})();
