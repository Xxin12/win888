'use strict';
/**
 * SQLite 存储层(零依赖, 使用 Node 22 内置 node:sqlite DatabaseSync)。
 *
 * 设计(按用户要求: 全部数据用 SQLite + 按股票代码做数据库隔离):
 *   - 每只股票一个独立 DB 文件: data/db/{code}.db  (code = sh/sz/bj + 6位)
 *       内含: kline_day / kline_5min / intraday / news / meta
 *       这样"打开某只股票"只需打开一个文件, 彻底避免原先扫描 10 万 CSV 的性能问题。
 *   - 跨股票/全局状态放一个 data/db/global.db:
 *       stock(股票池) / watchlist / portfolio / alert / notify_log / meta
 *
 * 说明: 本环境 node:sqlite 在未加 --experimental-sqlite flag 时亦可用,
 *       但 DatabaseSync 不暴露 .transaction() 方法; 故自实现 txn() 事务 Helper。
 */
const path = require('path');
const fs = require('fs');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  console.error('[db] 致命: 当前 Node 版本不支持 node:sqlite ——', e.message);
  throw e;
}

const DB_DIR = path.join(__dirname, '..', '..', 'data', 'db');
const GLOBAL_DB = path.join(DB_DIR, 'global.db');

// WAL + NORMAL 同步: 读多写少场景下性能与安全兼顾
const PRAGMA = 'PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;';

function ensureDir() { if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true }); }

/**
 * 事务 Helper(兼容无 flag 的 node:sqlite): 包裹 fn 在 BEGIN/COMMIT 之间, 异常自动 ROLLBACK。
 * @param {DatabaseSync} db
 * @param {Function} fn 事务体(可接收 args)
 * @param {...any} args
 */
function txn(db, fn, ...args) {
  db.exec('BEGIN');
  try {
    const r = fn(...args);
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  }
}

// ---------------- 全局 DB(单例) ----------------
let _global = null;
function globalDb() {
  ensureDir();
  if (_global) return _global;
  const db = new DatabaseSync(GLOBAL_DB);
  db.exec(PRAGMA);
  initGlobalSchema(db);
  _global = db;
  return db;
}
function initGlobalSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS stock(code TEXT PRIMARY KEY, name TEXT, market TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS watchlist(code TEXT PRIMARY KEY, name TEXT, grp TEXT);
    CREATE TABLE IF NOT EXISTS portfolio(id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, name TEXT, shares REAL, cost REAL, note TEXT);
    CREATE INDEX IF NOT EXISTS idx_pf_code ON portfolio(code);
    CREATE TABLE IF NOT EXISTS alert(id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, type TEXT, op TEXT, value REAL, note TEXT, enabled INTEGER, triggered INTEGER, last_hit TEXT);
    CREATE INDEX IF NOT EXISTS idx_alert_code ON alert(code);
    CREATE TABLE IF NOT EXISTS notify_log(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, type TEXT, code TEXT, name TEXT, detail TEXT, sig_key TEXT);
    CREATE TABLE IF NOT EXISTS stock_coverage(
      code TEXT PRIMARY KEY,
      has_day INTEGER DEFAULT 0,
      has_5min INTEGER DEFAULT 0,
      intraday_dates INTEGER DEFAULT 0,
      last_day_date TEXT,
      last_5min_date TEXT,
      last_backfill TEXT,
      scanned INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS stock_delist_probe(
      code TEXT PRIMARY KEY,
      delisted INTEGER DEFAULT 1,
      reason TEXT,
      probed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS dividend(
      code TEXT,
      ex_date TEXT,                       -- 除权除息日
      cash_per_share REAL,               -- 每股派息(税前, 元)
      bonus_per_share REAL DEFAULT 0,    -- 每股送股
      transfer_per_share REAL DEFAULT 0, -- 每股转增
      progress TEXT,                     -- 预案/实施
      fetched_at TEXT,
      PRIMARY KEY(code, ex_date)
    );
    CREATE INDEX IF NOT EXISTS idx_dividend_code ON dividend(code);
    CREATE TABLE IF NOT EXISTS bulk_backfill_queue(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,                              -- intraday | 5min | day
      source TEXT,                                    -- 数据源(可空=默认源)
      codes TEXT,                                     -- JSON 数组; NULL = 全市场
      force INTEGER DEFAULT 0,                        -- 1=强制重抓
      status TEXT NOT NULL DEFAULT 'pending',         -- pending | running | done | error
      error TEXT,                                     -- 异常信息(仅 error 态)
      progress TEXT,                                  -- JSON 快照: {total,done,ok,fail,skip,points,currentCode,phase}
      queued_at INTEGER,                              -- 入队时间(ms, 决定 FIFO 顺序)
      started_at INTEGER,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_bbq_status ON bulk_backfill_queue(status, queued_at);
  `);
  // 批量分时回补: 历史回看深度(days) / 日期区间(start,end) 选项(与单只历史回补一致)
  // 仅行情中心批量分时回补用到; 旧库表无此列, 用 ADD COLUMN 幂等迁移(列已存在则忽略报错)
  for (const col of ['days INTEGER', 'start TEXT', 'end TEXT', 'targeted INTEGER']) {
    try { db.exec(`ALTER TABLE bulk_backfill_queue ADD COLUMN ${col}`); } catch (_) { /* 列已存在, 忽略 */ }
  }
}

// ---------------- 每只股票一个 DB(LRU 缓存句柄) ----------------
const _stockCache = new Map(); // code -> DatabaseSync (插入顺序即 LRU)
const STOCK_CACHE_CAP = 256;   // 上限, 防止成千上万只股票同时打开耗尽文件描述符

/**
 * 打开某股票的独立 DB。
 * @param {string} code
 * @param {boolean} [readOnly] 只读查询(覆盖情况/读取)传 true: 文件不存在时**不新建空库**,
 *        直接返回 null —— 避免"翻页时顺手创建几千个空 .db 文件"的副作用与耗时。
 *        写入/落盘路径必须传 false(默认), 以确保库被创建。
 */
function stockDb(code, readOnly = false) {
  ensureDir();
  code = String(code);
  if (readOnly) {
    const file = path.join(DB_DIR, `${code}.db`);
    if (!fs.existsSync(file)) return null; // 无库即视为无数据, 直接短路
  }
  if (_stockCache.has(code)) {
    const db = _stockCache.get(code);
    _stockCache.delete(code); _stockCache.set(code, db); // 触摸为最新
    return db;
  }
  if (_stockCache.size >= STOCK_CACHE_CAP) {
    const oldest = _stockCache.keys().next().value;
    try { _stockCache.get(oldest).close(); } catch (_) { /* ignore */ }
    _stockCache.delete(oldest);
  }
  const file = path.join(DB_DIR, `${code}.db`);
  const db = new DatabaseSync(file);
  db.exec(PRAGMA);
  initStockSchema(db);
  _stockCache.set(code, db);
  return db;
}
function initStockSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS kline_day(date TEXT PRIMARY KEY, open REAL, high REAL, low REAL, close REAL, volume REAL, amount REAL, turnover REAL);
    CREATE TABLE IF NOT EXISTS kline_5min(datetime TEXT PRIMARY KEY, date TEXT, open REAL, high REAL, low REAL, close REAL, volume REAL, amount REAL);
    CREATE INDEX IF NOT EXISTS idx_5min_date ON kline_5min(date);
    CREATE TABLE IF NOT EXISTS intraday(date TEXT, time TEXT, price REAL, avg REAL, volume REAL, cum_volume REAL, PRIMARY KEY(date,time));
    CREATE INDEX IF NOT EXISTS idx_intraday_date ON intraday(date);
    CREATE TABLE IF NOT EXISTS news(ts TEXT, title TEXT, url TEXT, raw TEXT, PRIMARY KEY(ts,url));
  `);
}

function closeStockDb(code) {
  const db = _stockCache.get(code);
  if (db) { try { db.close(); } catch (_) { /* ignore */ } _stockCache.delete(code); }
}
function closeAll() {
  if (_global) { try { _global.close(); } catch (_) { /* ignore */ } _global = null; }
  for (const [, db] of _stockCache) { try { db.close(); } catch (_) { /* ignore */ } }
  _stockCache.clear();
}

// 由 6 位纯数字代码推断市场前缀(用于把 intraday 文件名 {short}_{date}.csv 还原为完整 code)
function prefixOf(short) {
  const s = String(short || '');
  if (/^(60|68|90|58|56|51)/.test(s)) return 'sh';
  if (/^(8|4|92)/.test(s)) return 'bj';
  return 'sz';
}

// 全局 meta 读写(迁移版本号等)
function setMeta(k, v) { globalDb().prepare('INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)').run(k, String(v)); }
function getMeta(k) { const r = globalDb().prepare('SELECT v FROM meta WHERE k=?').get(k); return r ? r.v : null; }

module.exports = {
  DB_DIR, GLOBAL_DB,
  globalDb, stockDb, closeStockDb, closeAll,
  prefixOf, txn, setMeta, getMeta,
};
