'use strict';
// 验证: ① /api/dividend 拉取+落库 ② 定投回测 红利再投 开关对比
const fs = require('fs');
const CODE = 'sz002027';
const CSV = 'E:/W888/分众传媒_002027_日线_截至20260803.csv';
const BASE = 'http://localhost:5178';

function normDate(v){let s=String(v||'').trim().replace(/[/.]/g,'-');if(/^\d{8}$/.test(s))return s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8);const m=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);return m?m[1]+'-'+String(m[2]).padStart(2,'0')+'-'+String(m[3]).padStart(2,'0'):'';}
function num(v){if(v==null||v==='')return NaN;const s=String(v).replace(/[,%\s+]/g,'');if(!s||s==='--'||s==='-')return NaN;const n=Number(s);return Number.isFinite(n)?n:NaN;}
function parseFzmeCsv(){
  const t=fs.readFileSync(CSV,'utf8').replace(/^﻿/,'').replace(/\r/g,'').split('\n').filter(Boolean);
  const head=t[0].split(',');
  const ci={date:head.findIndex(h=>h.includes('时间')),open:head.findIndex(h=>h.includes('开盘')),high:head.findIndex(h=>h.includes('最高')),low:head.findIndex(h=>h.includes('最低')),close:head.findIndex(h=>h.includes('收盘')),vol:head.findIndex(h=>h.includes('总手'))};
  const bars=[];
  for(let i=1;i<t.length;i++){const c=t[i].split(',');const date=normDate(c[ci.date]);if(!date)continue;const close=num(c[ci.close]);if(!Number.isFinite(close))continue;let open=num(c[ci.open]);if(!Number.isFinite(open))open=close;let high=num(c[ci.high]);if(!Number.isFinite(high))high=Math.max(open,close);let low=num(c[ci.low]);if(!Number.isFinite(low))low=Math.min(open,close);bars.push({date,open,high,low,close,volume:Number.isFinite(num(c[ci.vol]))?num(c[ci.vol]):0,amount:0});}
  bars.sort((a,b)=>a.date<b.date?-1:1);return bars;
}
async function post(p,b){const r=await fetch(BASE+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});return r.json();}
async function get(p){const r=await fetch(BASE+p);return r.json();}
let pass=0,fail=0;
function ok(name,cond,extra){if(cond){pass++;console.log('OK  '+name+(extra?('  '+extra):''));}else{fail++;console.log('FAIL '+name+(extra?('  '+extra):''));}}

(async()=>{
  const bars=parseFzmeCsv();
  console.log('解析分众CSV:',bars.length,'行');

  // ① 拉取分红
  const dv=await get('/api/dividend/'+CODE);
  ok('分红接口 ok', dv.ok===true, 'err='+(dv.error||''));
  ok('分红条数>0', dv.ok&&dv.count>0, 'count='+(dv.count||0));
  if(dv.dividends&&dv.dividends.length){const d=dv.dividends[dv.dividends.length-1];console.log('  最近分红:',JSON.stringify(d));}

  // ② 不带红利再投
  const no=await post('/api/backtest',{code:CODE,strategy:'dca',params:{priceType:'raw',dividendReinvest:false,amount:5000,freq:'monthly',carryOver:true,boostMode:'off',takeMode:'off'},bars});
  ok('无再投回测 ok', no.ok===true, 'err='+(no.error||''));
  const noShares=Math.round(Number((no.metrics||{}).shares||0));
  const noMv=(no.metrics||{}).market_value;
  const noProfit=(no.metrics||{}).profit;

  // ③ 带红利再投
  const yes=await post('/api/backtest',{code:CODE,strategy:'dca',params:{priceType:'raw',dividendReinvest:true,amount:5000,freq:'monthly',carryOver:true,boostMode:'off',takeMode:'off'},bars,dividends:dv.dividends});
  ok('再投回测 ok', yes.ok===true, 'err='+(yes.error||''));
  ok('dividend_applied=true', yes.ok&&yes.meta&&yes.meta.dividend_reinvest===true);
  ok('dividend_events>0', yes.ok&&(yes.metrics.dividend_events||0)>0, 'events='+(yes.metrics&&yes.metrics.dividend_events));
  ok('红利再投股数>0', yes.ok&&(yes.metrics.dividend_shares||0)>0, 'divShares='+(yes.metrics&&yes.metrics.dividend_shares));
  const yesShares=Math.round(Number((yes.metrics||{}).shares||0));
  ok('带再投持股数 > 无再投持股数', yesShares>noShares, 'yes='+yesShares+' no='+noShares);
  // 累计投入口径: 红利再投不计入本金
  ok('累计投入不含再投金额(相等)', Math.abs((yes.metrics.invested)-(no.metrics.invested))<1, 'yes.inv='+(yes.metrics&&yes.metrics.invested)+' no.inv='+(no.metrics&&no.metrics.invested));
  ok('再投金额>0', (yes.metrics.dividend_reinvested||0)>0, 'divAmt='+(yes.metrics&&yes.metrics.dividend_reinvested));
  // 总资产: 带再投应更高(因股数更多)
  ok('带再投总资产 >= 无再投', (yes.metrics.market_value+ (yes.metrics.realized||0)) >= (noMv+(no.metrics.realized||0)), 'yes.mv='+(yes.metrics&&yes.metrics.market_value)+' no.mv='+noMv);

  // ④ qfq 下红利再投应被忽略
  const qfq=await post('/api/backtest',{code:CODE,strategy:'dca',params:{priceType:'qfq',dividendReinvest:true,amount:5000,freq:'monthly',carryOver:true,boostMode:'off',takeMode:'off'},bars,dividends:dv.dividends});
  ok('qfq+再投被忽略(dividend_applied=false)', qfq.ok&&qfq.meta&&qfq.meta.dividend_reinvest===false);

  console.log('\n== 结果: PASS='+pass+' FAIL='+fail+' ==');
  process.exit(fail?1:0);
})().catch(e=>{console.error('ERR',e);process.exit(2);});
