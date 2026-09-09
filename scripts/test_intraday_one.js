'use strict';
const http = require('http');
function req(m,p,b){return new Promise((res,rej)=>{const d=b?JSON.stringify(b):null;const r=http.request({host:'127.0.0.1',port:5178,path:p,method:m,headers:d?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(d)}:{}},(resp)=>{let x='';resp.on('data',c=>x+=c);resp.on('end',()=>{try{res(JSON.parse(x));}catch(e){res({raw:x});}});});if(d)r.write(d);r.on('error',rej);r.end();});}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const code='sh000001';
  // 确保 db 不存在
  const {DB_DIR}=require('../server/lib/db.js');const fs=require('fs');const path=require('path');
  for(const s of ['','-wal','-shm']){const f=path.join(DB_DIR,code+'.db'+s);if(fs.existsSync(f))fs.unlinkSync(f);}
  const r=await req('POST','/api/backfill-bulk',{type:'intraday',codes:[code],force:true});
  console.log('触发 intraday sh000001:',JSON.stringify(r));
  let last='';
  for(let i=0;i<60;i++){
    const st=await req('GET','/api/backfill-bulk/status');
    const running=(st.jobs||[]).filter(j=>!j.finished).length;const q=st.queueLength||0;
    const line='poll '+i+': running='+running+' queue='+q;
    if(line!==last){console.log(line);last=line;}
    if(running===0&&q===0){console.log('>>> 完成');break;}
    await sleep(2000);
  }
  // 检查 intraday 数据
  const {DatabaseSync}=require('node:sqlite');const f=path.join(DB_DIR,code+'.db');
  if(!fs.existsSync(f)){console.log('[结果] 无DB文件');process.exit(0);}
  const db=new DatabaseSync(f);
  let rows=[];try{rows=db.prepare('SELECT * FROM intraday ORDER BY time').all();}catch(e){console.log('intraday读错:',e.message);}
  console.log('[结果] intraday 行数=',rows.length,'首行=',JSON.stringify(rows[0]||null),'末行=',JSON.stringify(rows[rows.length-1]||null));
  db.close();process.exit(0);
})().catch(e=>{console.log('FATAL',e.message);process.exit(1);});
