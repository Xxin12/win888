'use strict';
// 验证: ① 价格类型(raw/qfq)分支 ② 按股数买入模式
const fs = require('fs');
const node = 'C:/Users/miao/.workbuddy/binaries/node/versions/22.22.2/node.exe'; // not used; only Node22 global fetch
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
  for(let i=1;i<t.length;i++){
    const c=t[i].split(',');
    const date=normDate(c[ci.date]); if(!date)continue;
    const close=num(c[ci.close]); if(!Number.isFinite(close))continue;
    let open=num(c[ci.open]); if(!Number.isFinite(open))open=close;
    let high=num(c[ci.high]); if(!Number.isFinite(high))high=Math.max(open,close);
    let low=num(c[ci.low]); if(!Number.isFinite(low))low=Math.min(open,close);
    bars.push({date,open,high,low,close,volume:Number.isFinite(num(c[ci.vol]))?num(c[ci.vol]):0,amount:0});
  }
  bars.sort((a,b)=>a.date<b.date?-1:1);
  return bars;
}

// 合成除权(原始)数据: 120 个月, 全正价格, 含一次真实除权跳空(不缩复权)
function synthRaw(){
  const bars=[];
  for(let i=0;i<120;i++){
    const y=2015+Math.floor(i/12), m=(i%12)+1, d=15;
    let price=10+i*0.08;
    if(i===60) price*=0.7; // 真实除权日跳空, 价格仍为正
    bars.push({date:y+'-'+String(m).padStart(2,'0')+'-'+String(d).padStart(2,'0'),open:price*0.99,high:price*1.02,low:price*0.97,close:price,volume:1e6,amount:0});
  }
  return bars;
}

async function post(path,body){
  const r=await fetch(BASE+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  return r.json();
}

let pass=0,fail=0;
function ok(name,cond,extra){ if(cond){pass++;console.log('OK  '+name+(extra?('  '+extra):''));}else{fail++;console.log('FAIL '+name+(extra?('  '+extra):''));} }

(async()=>{
  const fz=parseFzmeCsv();
  console.log('解析分众CSV: '+fz.length+' 行');

  // ---- 回归: qfq 仍应截断到 2015-02-12 ----
  const qfq=await post('/api/backtest',{code:CODE,strategy:'dca',params:{priceType:'qfq',buyMode:'amount',freq:'monthly',amount:5000,carryOver:true,boostMode:'off',takeMode:'off'},bars:fz});
  ok('qfq 截断有效起点=2015-02-12', qfq.ok&&qfq.meta&&qfq.meta.from==='2015-02-12', 'from='+(qfq.meta&&qfq.meta.from));
  ok('qfq 期数=134', qfq.ok&&qfq.metrics.periods===134, 'periods='+(qfq.metrics&&qfq.metrics.periods));
  ok('qfq 含复权异常告警', qfq.ok&&qfq.meta.warnings.some(w=>w.indexOf('复权异常')>=0));

  // ---- qfq 数据误标为 raw: 不应截断(保留全部), 不报复权异常 ----
  const mis=await post('/api/backtest',{code:CODE,strategy:'dca',params:{priceType:'raw',buyMode:'amount',freq:'monthly',amount:5000},bars:fz});
  ok('raw分支不截断(保留全部行)', mis.meta&&mis.meta.skipped===0, 'skipped='+(mis.meta&&mis.meta.skipped)+' valid='+(mis.meta&&mis.meta.valid));
  ok('raw分支不报复权异常', mis.meta&&!mis.meta.warnings.some(w=>w.indexOf('复权异常')>=0));

  // ---- 合成除权数据: 按金额 ----
  const raw= await post('/api/backtest',{code:CODE,strategy:'dca',params:{priceType:'raw',buyMode:'amount',freq:'monthly',amount:5000},bars:synthRaw()});
  ok('raw数据回测成功', raw.ok===true, 'err='+(raw.error||''));
  ok('raw数据无截断(120根)', raw.ok&&raw.meta.valid===120, 'valid='+(raw.meta&&raw.meta.valid));
  ok('raw数据期数=买入明细数', raw.ok&&raw.metrics.periods===raw.trades.filter(t=>t.type==='buy').length, 'periods='+(raw.metrics&&raw.metrics.periods));
  ok('raw不含复权异常(仅含权提示)', raw.ok&&raw.meta.warnings.some(w=>w.indexOf('除权(原始)')>=0)&&!raw.meta.warnings.some(w=>w.indexOf('复权异常')>=0));

  // ---- 合成除权数据: 按股数(整百) 每期100股 ----
  const sh= await post('/api/backtest',{code:CODE,strategy:'dca',params:{priceType:'raw',buyMode:'shares',sharesPerPeriod:100,freq:'monthly',carryOver:true},bars:synthRaw()});
  const buyTrades = sh.ok ? sh.trades.filter(t=>t.type==='buy') : [];
  const sumInv = buyTrades.reduce((s,t)=>s + Number(t.amount) + Number(t.fee), 0);
  ok('按股数回测成功', sh.ok===true, 'err='+(sh.error||''));
  ok('按股数期数=明细数', sh.ok&&sh.metrics.periods===buyTrades.length && buyTrades.length>0, 'periods='+(sh.metrics&&sh.metrics.periods));
  ok('按股数总持股=期数×100', sh.ok&&Math.round(Number(sh.metrics.shares))===buyTrades.length*100, 'shares='+(sh.metrics&&sh.metrics.shares)+' exp='+(buyTrades.length*100));
  ok('按股数不启用加码(每笔mul=1)', sh.ok&&buyTrades.every(t=>t.mul===1));
  ok('按股数累计投入=Σ(金额+费)', sh.ok&&Math.abs(sh.metrics.invested - sumInv) < 1, 'inv='+(sh.metrics&&sh.metrics.invested)+' exp='+Math.round(sumInv));

  console.log('\n== 结果: PASS='+pass+' FAIL='+fail+' ==');
  process.exit(fail?1:0);
})().catch(e=>{console.error('ERR',e);process.exit(2);});
