'use strict';
const { MAJOR_INDICES } = require('../server/lib/indices.js');
const { DB_DIR } = require('../server/lib/db.js');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_DT = /^\d{14}$/;
const RE_T = /^\d{2}:\d{2}$/;
function rowBad(table, r){
  if(table==='intraday'){ if(!RE_DATE.test(r.date||''))return true; if(!(r.price>0)||r.price>100000)return true; if(!RE_T.test(r.t||''))return true; }
  else if(table==='kline_day'){ if(!RE_DATE.test(r.date||''))return true; if(!(r.close>0)||r.close>100000)return true; }
  else if(table==='kline_5min'){ if(!RE_DT.test(String(r.datetime||'')))return true; if(!(r.close>0)||r.close>100000)return true; }
  return false;
}
for(const x of MAJOR_INDICES){
  const f = path.join(DB_DIR, x.code+'.db');
  const wf = f+'-wal', sf = f+'-shm';
  const exists = fs.existsSync(f);
  const info = {exists, wal: fs.existsSync(wf), shm: fs.existsSync(sf)};
  if(exists){
    try{
      const db = new DatabaseSync(f);
      for(const t of ['kline_day','kline_5min','intraday']){
        try{
          const rows = db.prepare('SELECT * FROM '+t).all();
          let bad=0; for(const r of rows) if(rowBad(t,r)) bad++;
          info[t] = rows.length+'/'+bad;
        }catch(e){ info[t]='ERR:'+e.message; }
      }
      db.close();
    }catch(e){ info.openErr=e.message; }
  }
  console.log(x.code.padEnd(9), JSON.stringify(info));
}
