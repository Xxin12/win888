'use strict';
/**
 * 数据迁移: 把现有 CSV / JSON 落盘数据全部迁入 SQLite(按股票代码隔离)。
 *   - data/stocks/{code}_day.csv        -> data/db/{code}.db.kline_day
 *   - data/stocks/{code}_5min.csv       -> data/db/{code}.db.kline_5min
 *   - data/intraday/{short}_{date}.csv  -> data/db/{prefix+short}.db.intraday
 *   - stocks_universe_local.csv / .json -> global.db.stock
 *   - watchlist.json / portfolio.json / alerts.json -> global.db.{watchlist,portfolio,alert}
 *   - stocks/{short}_news.json          -> {code}.db.news
 *
 * 幂等: 全部 INSERT OR REPLACE(按主键); 重复运行安全。
 * 用法: node scripts/migrate_to_sqlite.js            (已迁移过则跳过, 除非 --force)
 *       node scripts/migrate_to_sqlite.js --force    (强制重跑全量)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const { stockDb, globalDb, prefixOf, txn, closeStockDb, closeAll, getMeta, setMeta } = require('../server/lib/db');
const { readCsv } = require('../server/lib/csv');
const gstore = require('../server/lib/globalStore');
const ms = require('../server/lib/marketStore');

const force = process.argv.includes('--force');
const log = (...a) => console.log('[migrate]', ...a);
const t0 = Date.now();
let migrated = 0;

// ---------------- 1) 日 K ----------------
function migrateDay() {
  const dir = path.join(DATA, 'stocks');
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((f) => /^[0-9a-z]+_day\.csv$/i.test(f));
  log(`日K: 发现 ${files.length} 个文件`);
  let n = 0;
  for (const f of files) {
    const short = f.replace(/_day\.csv$/i, '');
    const code = prefixOf(short) + short;
    const rows = readCsv(path.join(dir, f), ['open', 'high', 'low', 'close', 'volume', 'amount', 'turnover']);
    if (!rows.length) continue;
    const db = stockDb(code);
    const ins = db.prepare('INSERT OR REPLACE INTO kline_day(date,open,high,low,close,volume,amount,turnover) VALUES(?,?,?,?,?,?,?,?)');
    txn(db, (rs) => { for (const r of rs) ins.run(r.date, r.open, r.high, r.low, r.close, r.volume, r.amount || 0, r.turnover || 0); }, rows);
    closeStockDb(code);
    n += rows.length;
  }
  log(`日K: 写入 ${n} 行`);
  migrated++;
}

// ---------------- 2) 5 分钟 K ----------------
function migrate5min() {
  const dir = path.join(DATA, 'stocks');
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((f) => /^[0-9a-z]+_5min\.csv$/i.test(f));
  log(`5分钟K: 发现 ${files.length} 个文件`);
  let n = 0;
  for (const f of files) {
    const short = f.replace(/_5min\.csv$/i, '');
    const code = prefixOf(short) + short;
    const rows = readCsv(path.join(dir, f), ['open', 'high', 'low', 'close', 'volume', 'amount']);
    if (!rows.length) continue;
    const db = stockDb(code);
    const ins = db.prepare('INSERT OR REPLACE INTO kline_5min(datetime,date,open,high,low,close,volume,amount) VALUES(?,?,?,?,?,?,?,?)');
    txn(db, (rs) => { for (const r of rs) ins.run(r.datetime, r.date || String(r.datetime).slice(0, 10), r.open, r.high, r.low, r.close, r.volume, r.amount || 0); }, rows);
    closeStockDb(code);
    n += rows.length;
  }
  log(`5分钟K: 写入 ${n} 行`);
  migrated++;
}

// ---------------- 3) 分时(10万文件, 按股票分组批量事务) ----------------
function migrateIntraday() {
  const dir = path.join(DATA, 'intraday');
  if (!fs.existsSync(dir)) { log('分时: 目录不存在, 跳过'); return; }
  const files = fs.readdirSync(dir).filter((f) => /^(\d{6})_(\d{4}-\d{2}-\d{2})\.csv$/.test(f));
  log(`分时: 发现 ${files.length} 个文件, 按股票分组迁移...`);
  files.sort(); // 同股票文件名连续, 减少 DB 打开/关闭次数
  let total = 0, curCode = null, db = null, ins = null, count = 0;
  const flush = () => { if (db) { try { db.exec('COMMIT'); } catch (_) {} try { db.close(); } catch (_) {} db = null; } };
  try {
    for (const f of files) {
      const m = f.match(/^(\d{6})_(\d{4}-\d{2}-\d{2})\.csv$/);
      const short = m[1]; const date = m[2];
      const code = prefixOf(short) + short;
      if (code !== curCode) {
        if (db) { db.exec('COMMIT'); closeStockDb(curCode); }
        curCode = code;
        db = stockDb(code);
        db.exec('BEGIN');
        ins = db.prepare('INSERT OR REPLACE INTO intraday(date,time,price,avg,volume,cum_volume) VALUES(?,?,?,?,?,?)');
      }
      const rows = readCsv(path.join(dir, f), ['price', 'avg', 'volume', 'cum_volume']);
      for (const r of rows) { ins.run(date, r.time, r.price, r.avg, r.volume, r.cum_volume); total++; }
      count++;
      if (count % 20000 === 0) log(`分时: 已处理 ${count}/${files.length} 文件, ${total} 行`);
    }
    flush();
  } catch (e) {
    try { if (db) db.exec('ROLLBACK'); } catch (_) {}
    log('分时迁移异常:', e.message);
    throw e;
  }
  log(`分时: 写入 ${total} 行 (来自 ${count} 个文件)`);
  migrated++;
}

// ---------------- 4) 股票池 ----------------
function migrateUniverse() {
  let stocks = [];
  const cachePath = path.join(DATA, 'stocks_universe.json');
  if (fs.existsSync(cachePath)) {
    try { const j = JSON.parse(fs.readFileSync(cachePath, 'utf8')); if (Array.isArray(j.stocks) && j.stocks.length) stocks = j.stocks; } catch (_) {}
  }
  if (!stocks.length) {
    const snap = path.join(DATA, 'stocks_universe_local.csv');
    if (fs.existsSync(snap)) {
      const txt = fs.readFileSync(snap, 'utf8').trim().split(/\r?\n/).filter(Boolean);
      if (txt[0] && txt[0].startsWith('code,')) txt.shift();
      stocks = txt.map((ln) => { const [code, name, market] = ln.split(','); return { code, name: (name || code).replace(/^"|"$/g, ''), market: market || (code ? code.slice(0, 2) : '') }; });
    }
  }
  if (stocks.length) { gstore.upsertStocks(stocks); log(`股票池: 写入 ${stocks.length} 条`); }
  else log('股票池: 无数据, 跳过');
  migrated++;
}

// ---------------- 5) 自选 / 持仓 / 预警 ----------------
function migrateJsonState() {
  const wl = readJsonFile('watchlist.json');
  if (Array.isArray(wl) && wl.length) { for (const x of wl) gstore.addWatchlist({ code: x.code, name: x.name, group: x.group || '默认' }); log(`自选: 写入 ${wl.length} 条`); }
  const pf = readJsonFile('portfolio.json');
  if (Array.isArray(pf) && pf.length) { gstore.setPortfolio(pf.map((x) => ({ ...x, code: x.code }))); log(`持仓: 写入 ${pf.length} 条`); }
  const al = readJsonFile('alerts.json');
  if (Array.isArray(al) && al.length) { for (const a of al) gstore.addAlert(a); log(`预警: 写入 ${al.length} 条`); }
  migrated++;
}
function readJsonFile(name) { try { return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')); } catch (_) { return null; } }

// ---------------- 6) 新闻(按股票隔离) ----------------
function migrateNews() {
  const dir = path.join(DATA, 'stocks');
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((f) => /^(\d{6})_news\.json$/.test(f));
  if (!files.length) { log('新闻: 无文件, 跳过'); return; }
  let n = 0;
  for (const f of files) {
    const short = f.match(/^(\d{6})_news\.json$/)[1];
    const code = prefixOf(short) + short;
    let list = null;
    try { list = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { continue; }
    if (!Array.isArray(list) || !list.length) continue;
    ms.setNews(code, list);
    n += list.length;
  }
  log(`新闻: 写入 ${n} 条 (来自 ${files.length} 个文件)`);
  migrated++;
}

// ---------------- 主流程 ----------------
(async () => {
  if (!force && getMeta('migrated') === '1') {
    log('已迁移过(见 global.db meta.migrated=1)。如需重跑请加 --force。退出。');
    process.exit(0);
  }
  log('开始迁移 ->', DATA);
  migrateDay();
  migrate5min();
  migrateIntraday();
  migrateUniverse();
  migrateJsonState();
  migrateNews();
  setMeta('migrated', '1');
  setMeta('migrated_at', new Date().toISOString());
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  log(`迁移完成 ✓ 共 ${migrated} 个阶段, 耗时 ${sec}s。旧 CSV/JSON 保留在原始位置, 可手动归档。`);
  closeAll();
  process.exit(0);
})().catch((e) => { console.error('[migrate] 失败:', e); closeAll(); process.exit(1); });
