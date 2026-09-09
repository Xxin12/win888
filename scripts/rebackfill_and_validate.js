'use strict';
// 重补全部 15 指数(三类) + 严格校验数据正确性(无垃圾)
const http = require('http');
const ROOT = require('path').resolve(__dirname, '..');
const { MAJOR_INDICES } = require(ROOT + '/server/lib/indices.js');
const { DB_DIR } = require(ROOT + '/server/lib/db.js');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

function req(method, p, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: 5178, path: p, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
      (resp) => { let d = ''; resp.on('data', (c) => (d += c)); resp.on('end', () => { try { res(JSON.parse(d)); } catch (e) { res({ raw: d }); } }); });
    if (data) r.write(data); r.on('error', rej); r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_DT = /^\d{14}$/;
const RE_T = /^\d{2}:\d{2}$/;

// —— 严格合法性校验(与 production 的 validIntradayDate 对齐, 避免把脏数据当正常) ——
function isCalDate(s) {
  if (typeof s !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (y < 1990 || y > 2100) return false;
  if (mo < 1 || mo > 12) return false;
  const dim = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  if (d < 1 || d > dim) return false;
  if (mo === 2 && d === 29 && !(y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0))) return false;
  return true;
}
function isCalDateTime(s) {
  if (typeof s !== 'string') return false;
  if (/^\d{14}$/.test(s)) return true; // YYYYMMDDHHMMSS(无分隔)
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(:\d{2})?$/.exec(s);
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3], hh = +m[4], mm = +m[5];
  if (y < 1990 || y > 2100) return false;
  if (mo < 1 || mo > 12) return false;
  const dim = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  if (d < 1 || d > dim) return false;
  if (mo === 2 && d === 29 && !(y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0))) return false;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return false;
  return true;
}
function isHHMM(s) { const m = /^(\d{2}):(\d{2})$/.exec(s || ''); if (!m) return false; const hh = +m[1], mm = +m[2]; return hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59; }

function openDb(code) {
  const f = path.join(DB_DIR, code + '.db');
  if (!fs.existsSync(f)) return null;
  try { return new DatabaseSync(f); } catch (e) { return null; }
}
// 判单行是否垃圾: 日期非法 / 价格<=0 或 >100000(指数点位不可能这么高) / 时间非法
function rowBad(table, r) {
  if (table === 'intraday') {
    if (!isCalDate(r.date || '')) return true;
    if (!(r.price > 0) || r.price > 100000) return true;
    if (!isHHMM(r.t || r.time || '')) return true; // 列名 time(库) / t(接口返回)
  } else if (table === 'kline_day') {
    if (!isCalDate(r.date || '')) return true;
    if (!(r.close > 0) || r.close > 100000) return true;
  } else if (table === 'kline_5min') {
    if (!isCalDateTime(String(r.datetime || ''))) return true;
    if (!(r.close > 0) || r.close > 100000) return true;
  }
  return false;
}
function checkDb(code) {
  const db = openDb(code);
  if (!db) return { exists: false };
  const out = {};
  for (const t of ['kline_day', 'kline_5min', 'intraday']) {
    let rows; try { rows = db.prepare('SELECT * FROM ' + t).all(); } catch (e) { out[t] = { total: 0, bad: 0, err: e.message }; continue; }
    let bad = 0; let sample = '';
    for (const r of rows) { if (rowBad(t, r)) { bad++; if (!sample) sample = JSON.stringify(r).slice(0, 80); } }
    out[t] = { total: rows.length, bad, sample };
  }
  db.close();
  return { exists: true, tables: out };
}

(async () => {
  const codes = MAJOR_INDICES.map((x) => x.code);
  console.log('指数总数:', codes.length);

  // 1) 触发三类回补(显式 codes = 全部指数)
  for (const t of ['intraday', '5min', 'day']) {
    const r = await req('POST', '/api/backfill-bulk', { type: t, codes, force: true });
    console.log('触发 ' + t + ':', JSON.stringify(r));
  }

  // 2) 轮询到完成
  let last = '';
  for (let i = 0; i < 140; i++) {
    const st = await req('GET', '/api/backfill-bulk/status');
    const running = (st.jobs || []).filter((j) => !j.finished).length;
    const q = st.queueLength || 0;
    const line = 'poll ' + i + ': running=' + running + ' queue=' + q;
    if (line !== last) { console.log(line); last = line; }
    if (running === 0 && q === 0) { console.log('>>> 全部完成 (轮询 ' + i + ')'); break; }
    await sleep(3000);
  }

  // 3) 校验每个指数三类数据
  console.log('\n=== 数据正确性校验(应全部 bad=0) ===');
  let allOk = true;
  for (const code of codes) {
    const c = checkDb(code);
    if (!c.exists) { console.log('  [无DB] ' + code); allOk = false; continue; }
    const d = c.tables.kline_day, m = c.tables.kline_5min, id = c.tables.intraday;
    const tag = (d.bad === 0 && m.bad === 0 && id.bad === 0 && d.total > 0 && m.total > 0 && id.total > 0) ? '[OK]' : '[坏]';
    if (tag === '[坏]') allOk = false;
    console.log('  ' + tag + ' ' + code.padEnd(9) +
      ' day=' + d.total + '/' + d.bad +
      ' 5min=' + m.total + '/' + m.bad +
      ' intraday=' + id.total + '/' + id.bad);
    if (d.bad) console.log('       day样本:', d.sample);
    if (m.bad) console.log('       5min样本:', m.sample);
    if (id.bad) console.log('       intraday样本:', id.sample);
  }
  console.log('\n全部数据正常(无垃圾):', allOk ? 'YES' : 'NO');
  process.exit(0);
})().catch((e) => { console.log('FATAL', e.message); process.exit(1); });
