'use strict';
// 在真实"除权(raw)"数据上验证 红利再投(DRIP) 逻辑:
// 用合成 raw 日线(含除权缺口), 确认 DRIP 仅小幅增加股数、本金不变、股数在合理量级。
const BASE = 'http://localhost:5178';
const CODE = 'sh600000';

function iso(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function genBars(){
  const bars=[]; let i=0;
  const start=new Date('2021-01-01'), end=new Date('2024-12-31');
  const exDate='2023-06-15'; const divCash=2.00;
  let prevClose=null;
  for(let d=new Date(start); d<=end; d.setDate(d.getDate()+1)){
    const dow=d.getDay(); if(dow===0||dow===6) continue;
    const ds=iso(d);
    const p=25 + 4*Math.sin(i/40) + 1.5*Math.sin(i/13); // 18.5~30.5 区间波动
    let close=Math.round(p*100)/100;
    let open=Math.round((close*(1+0.002*Math.sin(i)))*100)/100;
    let high=Math.max(open,close)+0.3, low=Math.min(open,close)-0.3;
    // 除权缺口: 在 ex-date 把 OHLC 整体下调分红额, 模拟 raw 数据特征
    if(ds===exDate && prevClose!=null){ const gap=divCash; open=Math.round((prevClose-gap)*100)/100; close=Math.round((prevClose-gap-0.2)*100)/100; high=open+0.3; low=close-0.3; }
    bars.push({date:ds,open,high:Math.max(high,open,close),low:Math.min(low,open,close),close,volume:1e6,amount:0});
    prevClose=close; i++;
  }
  return {bars, exDate, divCash};
}
async function post(p,b){const r=await fetch(BASE+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});return r.json();}

let pass=0,fail=0;
function ok(n,c,e){if(c){pass++;console.log('OK  '+n+(e?'  '+e:''));}else{fail++;console.log('FAIL '+n+(e?'  '+e:''));}}

(async()=>{
  const {bars,exDate,divCash}=genBars();
  console.log('合成 raw 日线:',bars.length,'行; 除权日',exDate,'分红/股',divCash);
  const exBar=bars.find(b=>b.date===exDate);
  console.log('  除权日收盘(应有缺口):',exBar.close);

  const divs=[{exDate, cashPerShare:divCash, bonusPerShare:0, transferPerShare:0, progress:'实施'}];
  const base={code:CODE,strategy:'dca',params:{priceType:'raw',dividendReinvest:false,amount:5000,freq:'monthly',carryOver:true,boostMode:'off',takeMode:'off'},bars};

  const no=await post('/api/backtest',base);
  ok('raw-无再投 ok', no.ok===true, 'err='+(no.error||''));
  const noShares=Math.round(Number((no.metrics||{}).shares||0));
  const noInv=(no.metrics||{}).invested;

  const yes=await post('/api/backtest',Object.assign({},base,{params:Object.assign({},base.params,{dividendReinvest:true}),dividends:divs}));
  ok('raw-再投 ok', yes.ok===true, 'err='+(yes.error||''));
  ok('dividend_applied=true', yes.meta&&yes.meta.dividend_reinvest===true);
  ok('dividend_events=1', (yes.metrics.dividend_events||0)===1, 'events='+(yes.metrics&&yes.metrics.dividend_events));
  const yesShares=Math.round(Number((yes.metrics||{}).shares||0));
  const divShares=Math.round(Number((yes.metrics.dividend_shares)||0));
  ok('带再投持股数 > 无再投', yesShares>noShares, 'yes='+yesShares+' no='+noShares);
  ok('累计投入不变(不含再投)', Math.abs(yes.metrics.invested-noInv)<1, 'yes.inv='+yes.metrics.invested+' no.inv='+noInv);
  ok('再投金额>0', (yes.metrics.dividend_reinvested||0)>0, 'divAmt='+(yes.metrics&&yes.metrics.dividend_reinvested));
  // 合理量级: 4年×12×5000≈24万本金, 均价~25 → 约9600股; 单次¥2分红再投约+800股。绝不可能是百万级。
  ok('无再投股数量级合理(<5万)', noShares>0 && noShares<50000, 'noShares='+noShares);
  ok('红利再投股数合理(100~5000)', divShares>=100 && divShares<=5000, 'divShares='+divShares);
  ok('带再投股数量级合理(<5万)', yesShares>0 && yesShares<50000, 'yesShares='+yesShares);
  // DRIP 小幅增厚(再投股数应明显小于基础持仓)
  ok('再投股数 << 基础持仓(微量增厚)', divShares < noShares*0.3, 'div='+divShares+' base='+noShares);

  console.log('\n== raw-DRIP 结果: PASS='+pass+' FAIL='+fail+' ==');
  process.exit(fail?1:0);
})().catch(e=>{console.error('ERR',e);process.exit(2);});
