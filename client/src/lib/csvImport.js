// 日线 CSV 手动导入: 编码探测 / 解析 / 列识别 / 清洗 / 体检
// 设计要点见 量化系统_定投策略回测_需求文档.md 第 4 章
// 不依赖任何第三方库; 解析结果以 JSON 随回测请求提交(后端 express.json 上限 15mb)

// ---- 编码探测: 优先 UTF-8, 出现替换字符则回退 GBK ----
export function decodeBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let utf8 = '';
  try { utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes); } catch (_) { utf8 = ''; }
  const badUtf8 = (utf8.match(/\uFFFD/g) || []).length;
  if (utf8 && badUtf8 === 0) return { text: stripBom(utf8), encoding: 'utf-8' };
  let gbk = '';
  try { gbk = new TextDecoder('gbk', { fatal: false }).decode(bytes); } catch (_) { gbk = ''; }
  const badGbk = gbk ? (gbk.match(/\uFFFD/g) || []).length : Infinity;
  if (gbk && badGbk < badUtf8) return { text: stripBom(gbk), encoding: 'gbk' };
  return { text: stripBom(utf8 || gbk), encoding: badUtf8 === 0 ? 'utf-8' : 'gbk?' };
}

function stripBom(s) { return s && s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; }

export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('文件读取失败'));
    fr.onload = () => { try { resolve(decodeBuffer(fr.result)); } catch (e) { reject(e); } };
    fr.readAsArrayBuffer(file);
  });
}

// ---- CSV 解析(支持引号包裹字段与制表符分隔) ----
export function parseCsv(text) {
  const lines = String(text || '').split(/\r\n|\r|\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return { head: [], rows: [] };
  const sep = lines[0].indexOf('\t') >= 0 && lines[0].indexOf(',') < 0 ? '\t' : ',';
  const split = (line) => {
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === sep) { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  const head = split(lines[0]);
  // 剥掉行尾空列(导出文件常见的多余分隔符)
  while (head.length && head[head.length - 1] === '') head.pop();
  const rows = [];
  for (let i = 1; i < lines.length; i++) rows.push(split(lines[i]));
  return { head, rows, sep };
}

// ---- 列识别 ----
const KEYS = {
  date: ['时间', '日期', 'date', 'time', 'trade_date'],
  open: ['开盘', 'open'],
  high: ['最高', 'high'],
  low: ['最低', 'low'],
  close: ['收盘', 'close'],
  volume: ['总手', '成交量', 'volume', 'vol'],
  amount: ['金额', '成交额', 'amount', 'turnover_amount'],
};
export const FIELDS = [
  { k: 'date', t: '日期', req: true }, { k: 'open', t: '开盘', req: true },
  { k: 'high', t: '最高', req: false }, { k: 'low', t: '最低', req: false },
  { k: 'close', t: '收盘', req: true }, { k: 'volume', t: '成交量', req: false },
  { k: 'amount', t: '成交额', req: false },
];

export function detectColumns(head) {
  const m = {};
  const used = new Set();
  for (const f of FIELDS) {
    const kws = KEYS[f.k];
    let idx = -1;
    for (let i = 0; i < head.length; i++) {
      if (used.has(i) || !head[i]) continue;
      const h = String(head[i]).toLowerCase();
      // 「换手」含「手」会误命中「总手」, 故成交量需排除「换手」
      if (f.k === 'volume' && h.indexOf('换手') >= 0) continue;
      if (kws.some((k) => h.indexOf(k.toLowerCase()) >= 0)) { idx = i; break; }
    }
    if (idx >= 0) { m[f.k] = idx; used.add(idx); } else m[f.k] = -1;
  }
  return m;
}

// ---- 数值/日期归一(与后端 dca.js 口径一致) ----
export function normDate(v) {
  if (v == null) return '';
  const s = String(v).trim().replace(/[\/.]/g, '-');
  if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return '';
  return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
}
export function num(v) {
  if (v == null || v === '') return NaN;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[,%\s+]/g, '');
  if (!s || s === '--' || s === '-') return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

// ---- 按映射构建日线数组 ----
export function buildBars(rows, map) {
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

// ---- 数据体检(前端预览用; 与后端清洗规则保持一致) ----
export function inspect(bars, priceType) {
  const total = bars.length;
  const isRaw = priceType === 'raw';
  if (!total) return { ok: false, total: 0, error: '未解析到任何有效数据行' };
  // 最后一个非正价格之后才是连续有效区间(借壳股前复权会在零点反复穿越)
  let lastBad = -1;
  for (let i = 0; i < total; i++) if (!(bars[i].open > 0 && bars[i].close > 0)) lastBad = i;
  const validFrom = isRaw ? 0 : lastBad + 1;
  const valid = bars.slice(validFrom);
  const issues = [];
  if (!isRaw && lastBad >= 0) {
    issues.push({
      lv: 'warn',
      msg: '已跳过前 ' + (lastBad + 1) + ' 行非正价格数据（前复权早期区间，最后一个异常日 ' +
        bars[lastBad].date + '），有效区间自 ' + (valid[0] ? valid[0].date : '-') + ' 起',
    });
  }
  if (valid.length < 60) {
    return { ok: false, total, valid: valid.length, issues, error: '有效行数不足 60 行，无法进行定投回测' };
  }
  if (!isRaw) {
    // 复权异常
    let lo = Infinity, hi = 0;
    for (const b of valid) { if (b.close < lo) lo = b.close; if (b.close > hi) hi = b.close; }
    if (lo > 0 && hi / lo > 20) {
      issues.push({
        lv: 'warn',
        msg: '⚠️ 复权异常：区间内最高收盘价是最低价的 ' + Math.round(hi / lo) + ' 倍（最低 ' + lo +
          ' 元）。常见于借壳上市或巨额送转股的前复权序列，从最早日期起投会让收益率严重虚高，建议起始日设在近 5~10 年内。',
      });
    }
  } else {
    issues.push({
      lv: 'info',
      msg: 'ℹ️ 按「除权(原始)」数据解析：历史除权日价格跳空为真实除权，定投收益未含现金红利再投，长期收益会略低于含权口径。',
    });
  }
  // 日期空洞
  for (let i = 1; i < valid.length; i++) {
    const gap = (Date.parse(valid[i].date) - Date.parse(valid[i - 1].date)) / 86400000;
    if (gap > 30) {
      issues.push({ lv: 'warn', msg: '数据存在空洞：' + valid[i - 1].date + ' → ' + valid[i].date + '（' + Math.round(gap) + ' 天，可能为长期停牌）' });
      break;
    }
  }
  // 重复日期
  const seen = new Set(); let dup = 0;
  for (const b of valid) { if (seen.has(b.date)) dup++; else seen.add(b.date); }
  if (dup) issues.push({ lv: 'warn', msg: '存在 ' + dup + ' 个重复日期，导入时后者覆盖前者' });

  return {
    ok: true, total, valid: valid.length, skipped: total - valid.length,
    from: valid[0].date, to: valid[valid.length - 1].date,
    fullFrom: bars[0].date, fullTo: bars[total - 1].date,
    lastClose: valid[valid.length - 1].close, issues,
  };
}

// 快捷区间: 返回 YYYY-MM-DD
export function shiftYears(dateStr, years) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setFullYear(d.getFullYear() - years);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
