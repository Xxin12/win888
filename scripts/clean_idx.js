'use strict';
const { MAJOR_INDICES } = require('../server/lib/indices.js');
const { DB_DIR } = require('../server/lib/db.js');
const fs = require('fs');
const path = require('path');
let n=0;
for(const x of MAJOR_INDICES){
  for(const suf of ['', '-wal', '-shm']){
    const f = path.join(DB_DIR, x.code + '.db' + suf);
    if(fs.existsSync(f)){ fs.unlinkSync(f); n++; }
  }
}
console.log('已删除索引相关文件:', n);
