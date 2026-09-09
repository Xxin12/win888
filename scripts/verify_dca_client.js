'use strict';
// 客户端验证: 假设真实服务已在 localhost:5178 运行; 用真实 CSV 走 /import/dayline -> /api/backtest(定投)
// 内置与 client/src/lib/csvImport.js 完全一致的解析逻辑(因项目非 ESM, 无法直接 import)
const fs = require('fs');
const ROOT = 'E:\\W888\\quant-web';
const CSV = 'E:\\W888\\分众传媒_002027_日线_截至20260803.csv';
const CODE = 'sz002027';
const PORT = 5178;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stripBom(s) { return s && s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; }
function decodeBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let utf8 = '';
  try { utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes); } catch (_) { utf8 = ''; }
  const badUtf8 = (utf8.match(/﻿/g) || []).length;
  if (utf8 && badUtf8 === 0) return { text: stripBom(utf8), encoding: 'utf-8' };
  let gbk = '';
  try { gbk = new TextDecoder('gbk', { fatal: false }).decode(bytes); } catch (_) { gbk = ''; }
  const badGbk = gbk ? (gbk.match(/﻿/g) || []).length : Infinity;
  if (gbk && badGbk < badUtf8) return { text: stripBom(gbk), encoding: 'gbk' };
  return { text: stripBom(utf8 || gbk), encoding: badUtf8 === 0 ? 'utf-8' : 'gbk?' };
}
function parseCsv(text) {
  const lines = String(text || '').split(/\r\n|\r|\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return { head: [], rows: [] };
  const sep = lines[0].indexOf('\t') >= 0 && lines[0].indexOf(',') < 0 ? '\t' : ',';
  const split = (line) => {
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === sep) { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  const head = split(lines[0]);
  while (head.length && head[head.length - 1] === '') head.pop();
  const rows = [];
  for (let i = 1; i < lines.length; i++) rows.push(split(lines[i]));
  return { head, rows, sep };
}
const KEYS = {
  date: ['时间', '日期', 'date', 'time', 'trade_date'], open: ['开盘', 'open'], high: ['最高', 'high'],
  low: ['最低', 'low'], close: ['收盘', 'close'], volume: ['总手', '成交量', 'volume', 'vol'],
  amount: ['金额', '成交额', 'amount', 'turnover_amount'],
};
const FIELDS = [
  { k: 'date', t: '日期', req: true }, { k: 'open', t: '开盘', req: true }, { k: 'high', t: '最高', req: false },
  { k: 'low', t: '最低', req: false }, { k: 'close', t: '收盘', req: true }, { k: 'volume', t: '成交量', req: false },
  { k: 'amount', t: '成交额', req: false },
];
function detectColumns(head) {
  const m = {}; const used = new Set();
  for (const f of FIELDS) {
    const kws = KEYS[f.k]; let idx = -1;
    for (let i = 0; i < head.length; i++) {
      if (used.has(i) || !head[i]) continue;
      const h = String(head[i]).toLowerCase();
      if (f.k === 'volume' && h.indexOf('换手') >= 0) continue;
      if (kws.some((k) => h.indexOf(k.toLowerCase()) >= 0)) { idx = i; break; }
    }
    if (idx >= 0) { m[f.k] = idx; used.add(idx); } else m[f.k] = -1;
  }
  return m;
}
function normDate(v) {
  if (v == null) return '';
  const s = String(v).trim().replace(/[\/.]/g, '-');
  if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return '';
  return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
}
function num(v) {
  if (v == null || v === '') return NaN;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[,%\s+]/g, '');
  if (!s || s === '--' || s === '-') return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}
function buildBars(rows, map) {
  const out = [];
  for (const r of rows) {
    const date = normDate(map.date >= 0 ? r[map.date] : '');
    if (!date) continue;
    const close = num(map.close >= 0 ? r[map.close] : NaN);
    if (!Number.isFinite(close)) continue;
    let open = num(map.open >= 0 ? r[map.open] : NaN);
    if (!Number.isFinite(open)) open = close;
    const high = num(map.high >= 0 ? r[map.high] : NaN);
    const low = num(map.low >= 0 ? r[map.low] : NaN);
    const volume = num(map.volume >= 0 ? r[map.volume] : NaN);
    const amount = num(map.amount >= 0 ? r[map.amount] : NaN);
    out.push({
      date, open, close,
      high: Number.isFinite(high) ? high : Math.max(open, close),
      low: Number.isFinite(low) ? low : Math.min(open, close),
      volume: Number.isFinite(volume) ? volume : 0,
      amount: Number.isFinite(amount) ? amount : 0,
    });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : 1));
  return out;
}

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://localhost:${PORT}/`); if (r && r.status >= 200) return true; } catch (_) {}
    await sleep(400);
  }
  return false;
}
async function post(url, body) {
  const r = await fetch(`http://localhost:${PORT}${url}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json();
}

(async () => {
  const up = await waitUp();
  if (!up) { console.log('SERVER_FAIL: 服务未在 5178 运行'); process.exit(1); }
  console.log('SERVER_OK');

  const buf = fs.readFileSync(CSV);
  const { text } = decodeBuffer(buf);
  const { head, rows } = parseCsv(text);
  const mapping = detectColumns(head);
  const bars = buildBars(rows, mapping);
  console.log('PARSED bars=' + bars.length + ' from=' + bars[0].date + ' to=' + bars[bars.length - 1].date);
  console.log('MAPPING ' + JSON.stringify(mapping) + ' head=' + JSON.stringify(head));

  const imp = await post('/api/import/dayline', { code: CODE, bars });
  console.log('IMPORT ' + JSON.stringify(imp).slice(0, 280));

  const defParams = {
    freq: 'monthly', everyNDays: 20, dayOfWeek: 1, dayOfMonth: 1, amount: 5000,
    priceMode: 'close', lotMode: 'lot100', carryOver: true, boostMode: 'off', maPeriod: 250,
    boostTiers: null, dropPct: 5, dropMul: 2, takeMode: 'off', takeValue: 30, afterTake: 'restart',
    start: '', end: '', commRate: 0.00025, commMin: 5, stampRate: 0.0005, transferRate: 0.00001, benchRate: 3,
  };
  const bt = await post('/api/backtest', { code: CODE, strategy: 'dca', params: defParams, bars });
  console.log('BACKTEST(import) ok=' + bt.ok + ' err=' + (bt.error || ''));
  if (bt.ok) {
    const m = bt.metrics || {};
    console.log('  periods=' + (bt.timeline ? bt.timeline.length : 0) + ' invested=' + m.invested +
      ' ret%=' + m.return_pct + ' xirr%=' + m.xirr + ' mv=' + m.market_value + ' realized=' + m.realized +
      ' mdd_pp=' + m.max_drawdown + ' maxloss%=' + m.max_loss_pct + ' trades=' + (bt.trades || []).length);
    console.log('  compare=' + JSON.stringify(bt.compare).slice(0, 360));
  }

  const bt2 = await post('/api/backtest', { code: CODE, strategy: 'dca', params: defParams, bars: null });
  console.log('BACKTEST(db-fallback) ok=' + bt2.ok + ' err=' + (bt2.error || '') +
    (bt2.ok ? ' invested=' + (bt2.metrics || {}).invested : ''));

  const downParams = Object.assign({}, defParams, { buyRule: 'downtick' });
  const bt3 = await post('/api/backtest', { code: CODE, strategy: 'dca', params: downParams, bars });
  console.log('BACKTEST(downtick) ok=' + bt3.ok + ' err=' + (bt3.error || ''));
  if (bt3.ok) {
    const m = bt3.metrics || {};
    console.log('  periods=' + m.periods + ' 上涨跳过=' + (m.downtick_skips || 0) + ' invested=' + m.invested +
      ' ret%=' + m.return_pct + ' xirr%=' + m.xirr + ' fee=' + m.fee);
  }
  process.exit(0);
})().catch((e) => { console.log('FATAL ' + (e && e.stack ? e.stack : e)); process.exit(1); });
