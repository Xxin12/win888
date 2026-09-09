// Scan all intraday CSVs for the TDX "shares-node" avg-unit bug.
// Corruption signature: avg ≈ price/100 (computed avg was 1/100 of correct).
//   - median(avg/price) ≈ 1.0   -> OK
//   - median(avg/price) ≈ 0.01  -> CORRUPTED (shares node, factor 100)
//   - in between         -> PARTIAL (mixed nodes within a file)
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'intraday');
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.csv')).sort();

function median(arr) {
  if (!arr.length) return NaN;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

const perStock = {};
const corrupted = [];
const partial = [];

for (const f of files) {
  const code = f.slice(0, 6);
  const full = path.join(DIR, f);
  const text = fs.readFileSync(full, 'utf8').trim();
  const lines = text.split('\n').filter(Boolean);
  const ratios = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    const price = parseFloat(c[1]);
    const avg = parseFloat(c[2]);
    if (!(price > 0) || !(avg > 0)) continue;
    ratios.push(avg / price);
  }
  if (!ratios.length) { (perStock[code] = perStock[code] || {ok:0,bad:0,partial:0}); continue; }
  const med = median(ratios);
  let status;
  if (med < 0.2) status = 'CORRUPTED';
  else if (med > 0.5) status = 'OK';
  else status = 'PARTIAL';
  const rec = { file: f, med: +med.toFixed(4), rows: ratios.length, status };
  if (status === 'CORRUPTED') { corrupted.push(rec); }
  else if (status === 'PARTIAL') { partial.push(rec); }
  const s = (perStock[code] = perStock[code] || { ok: 0, bad: 0, partial: 0 });
  if (status === 'OK') s.ok++; else if (status === 'CORRUPTED') s.bad++; else s.partial++;
}

console.log('=== Per-stock summary (OK / CORRUPTED / PARTIAL file counts) ===');
for (const [code, s] of Object.entries(perStock)) {
  console.log(`${code}: OK=${s.ok}  CORRUPTED=${s.bad}  PARTIAL=${s.partial}`);
}
console.log('\n=== CORRUPTED files (need re-backfill via fixed code) ===');
for (const r of corrupted) console.log(`${r.file}  median(avg/price)=${r.med}  rows=${r.rows}`);
console.log(`\nTotal corrupted: ${corrupted.length}, partial: ${partial.length}, scanned: ${files.length}`);
if (partial.length) {
  console.log('\n=== PARTIAL (mixed nodes, inspect manually) ===');
  for (const r of partial) console.log(`${r.file}  median(avg/price)=${r.med}  rows=${r.rows}`);
}
