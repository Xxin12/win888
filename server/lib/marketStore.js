'use strict';
/**
 * 时序数据读写层(按股票代码隔离, 底层为 data/db/{code}.db)。
 * 所有函数返回的数组结构, 与改造前的 CSV 读取结果完全兼容,
 * 因此 klineService / intradayRecorder / backtest 只需替换读写调用, 业务逻辑不变。
 */
const { stockDb, closeStockDb, txn } = require('./db');
const gstore = require('./globalStore'); // 全局 SQLite(股票池 + 回补覆盖索引 stock_coverage)

// ---------------- 回补覆盖情况: 落库到 global.db.stock_coverage ----------------
// 每只股票回补落盘(save*)后, 立即把 hasDay/has5min/intradayDates 记入 stock_coverage 表。
// /api/stocks/coverage 直接按 code IN (...) 批量查该表, 无需再为每只股票打开独立 .db 文件。
// 服务启动时为全市场股票 seed 默认行(全 0), 未回补股票也秒级返回 0。
function recordCoverage(code) {
  code = String(code);
  const db = stockDb(code, true);
  if (!db) { gstore.upsertCoverage(code, { hasDay: 0, has5min: 0, intradayDates: 0 }); return; }
  const hasDay = db.prepare('SELECT 1 FROM kline_day LIMIT 1').get() ? 1 : 0;
  const has5min = db.prepare('SELECT 1 FROM kline_5min LIMIT 1').get() ? 1 : 0;
  const intradayDates = (db.prepare('SELECT COUNT(DISTINCT date) c FROM intraday').get().c) || 0;
  const lastDayDate = (() => { const r = db.prepare('SELECT MAX(date) d FROM kline_day').get(); return r && r.d ? r.d : ''; })();
  const last5minDate = (() => { const r = db.prepare('SELECT MAX(date) d FROM kline_5min').get(); return r && r.d ? r.d : ''; })();
  gstore.upsertCoverage(code, { hasDay, has5min, intradayDates, lastDayDate, last5minDate });
}
// 单只查询兜底; 路由实际走 gstore.getCoverageMap 批量查询
function getCoverage(code) {
  const c = gstore.getCoverageMap([String(code)]).get(String(code));
  return c ? { has5min: !!c.has5min, hasDay: !!c.hasDay, intradayDates: c.intradayDates || 0 }
           : { has5min: false, hasDay: false, intradayDates: 0 };
}

// ---------------- 日 K ----------------
function getDayBars(code) {
  const db = stockDb(code, true);
  if (!db) return [];
  return db.prepare('SELECT date,open,high,low,close,volume,amount,turnover FROM kline_day ORDER BY date ASC').all()
    .map((r) => ({ date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume, amount: r.amount, turnover: r.turnover }));
}
function saveDayBars(code, bars) {
  if (!bars || !bars.length) return 0;
  const db = stockDb(code);
  const ins = db.prepare('INSERT OR REPLACE INTO kline_day(date,open,high,low,close,volume,amount,turnover) VALUES(?,?,?,?,?,?,?,?)');
  txn(db, (rows) => { for (const b of rows) ins.run(b.date, b.open, b.high, b.low, b.close, b.volume, b.amount || 0, b.turnover || 0); }, bars);
  recordCoverage(code);
  return bars.length;
}
function hasDay(code) { const db = stockDb(code, true); return db ? !!db.prepare('SELECT 1 FROM kline_day LIMIT 1').get() : false; }
function lastDayDate(code) { const db = stockDb(code, true); if (!db) return ''; const r = db.prepare('SELECT MAX(date) AS d FROM kline_day').get(); return r && r.d ? r.d : ''; }

// ---------------- 5 分钟 K ----------------
function get5minBars(code) {
  const db = stockDb(code, true);
  if (!db) return [];
  return db.prepare('SELECT datetime,date,open,high,low,close,volume,amount FROM kline_5min ORDER BY datetime ASC').all()
    .map((r) => ({ datetime: r.datetime, date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume, amount: r.amount }));
}
function save5minBars(code, bars) {
  if (!bars || !bars.length) return 0;
  const db = stockDb(code);
  const ins = db.prepare('INSERT OR REPLACE INTO kline_5min(datetime,date,open,high,low,close,volume,amount) VALUES(?,?,?,?,?,?,?,?)');
  txn(db, (rows) => {
    for (const b of rows) ins.run(b.datetime, b.date || String(b.datetime).slice(0, 10), b.open, b.high, b.low, b.close, b.volume, b.amount || 0);
  }, bars);
  recordCoverage(code);
  return bars.length;
}
function has5min(code) { const db = stockDb(code, true); return db ? !!db.prepare('SELECT 1 FROM kline_5min LIMIT 1').get() : false; }

// ---------------- 分时 ----------------
/** 严格校验分时日期: YYYY-MM-DD 且为真实日历日期(排除 2030-00-08 之类脏数据)。 */
function validIntradayDate(d) {
  if (typeof d !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return false;
  const y = +m[1], mo = +m[2], da = +m[3];
  if (y < 1990 || y > 2100) return false;
  if (mo < 1 || mo > 12) return false;
  const dim = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  if (da < 1 || da > dim) return false;
  // 闰年修正: 非闰年二月最多 28 天
  if (mo === 2 && da === 29 && !(y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0))) return false;
  return true;
}
/** 校验单条分时行: 时间 HH:MM 合法 + 价格有限且在合理区间(>0 且 <100000 对指数/个股均成立)。 */
function validIntradayRow(r) {
  if (!r || typeof r !== 'object') return false;
  const t = r.t || r.time;
  if (typeof t !== 'string') return false;
  const tm = /^(\d{2}):(\d{2})$/.exec(t);
  if (!tm) return false;
  const hh = +tm[1], mm = +tm[2];
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return false;
  const pr = parseFloat(r.price);
  if (!isFinite(pr) || pr <= 0 || pr > 100000) return false;
  return true;
}
// 返回 { date, rows:[{t,price,avg,volume,cumVolume}] } 或 null (与旧 readIntraday 一致)
function getIntraday(code, date) {
  const db = stockDb(code, true);
  if (!db) return null;
  const rows = db.prepare('SELECT time,price,avg,volume,cum_volume FROM intraday WHERE date=? ORDER BY time ASC').all(date);
  return rows.length ? { date, rows: rows.map((r) => ({ t: r.time, price: r.price, avg: r.avg, volume: r.volume, cumVolume: r.cum_volume })) } : null;
}
function saveIntraday(code, date, rows) {
  if (!rows || !rows.length) return 0;
  if (!validIntradayDate(date)) return 0; // 日期非法(脏数据) → 整批拒写, 返回 0
  // 逐行校验, 仅写入有效行; 过滤掉价格/时间非法的脏数据(典型: TDX 对指数返回 2030-00-08 / price 7万+ 的损坏序列)
  const good = rows.filter(validIntradayRow);
  if (!good.length) return 0;
  const db = stockDb(code);
  const ins = db.prepare('INSERT OR REPLACE INTO intraday(date,time,price,avg,volume,cum_volume) VALUES(?,?,?,?,?,?)');
  txn(db, (rs) => { for (const r of rs) ins.run(date, r.t || r.time, r.price, r.avg, r.volume, r.cumVolume ?? r.cum_volume); }, good);
  recordCoverage(code);
  return good.length;
}
// 列出某股票所有已保存分时日期(降序)
function listIntradayDates(code) {
  const db = stockDb(code, true);
  if (!db) return [];
  return db.prepare('SELECT DISTINCT date FROM intraday ORDER BY date DESC').all().map((r) => r.date);
}
function hasIntradayDate(code, date) { const db = stockDb(code, true); return db ? !!db.prepare('SELECT 1 FROM intraday WHERE date=? LIMIT 1').get(date) : false; }
// 本地是否已存在"任意"分时数据(不关心日期/完整度)。用于批量回补「有即跳过、零请求」。
function hasIntraday(code) { const db = stockDb(code, true); return db ? !!db.prepare('SELECT 1 FROM intraday LIMIT 1').get() : false; }

// ---------------- 个股新闻(按股票隔离) ----------------
function getNews(code) {
  const db = stockDb(code, true);
  if (!db) return [];
  return db.prepare('SELECT ts,title,url,raw FROM news ORDER BY ts DESC').all()
    .map((r) => ({ ts: r.ts, title: r.title, url: r.url, raw: r.raw ? safeParse(r.raw) : undefined }));
}
function setNews(code, list) {
  const db = stockDb(code);
  const del = db.prepare('DELETE FROM news');
  const ins = db.prepare('INSERT OR REPLACE INTO news(ts,title,url,raw) VALUES(?,?,?,?)');
  txn(db, (rows) => {
    del.run();
    for (const n of (rows || [])) ins.run(n.ts || n.time || '', n.title || '', n.url || '', n.raw ? JSON.stringify(n.raw) : '');
  }, list);
}
function safeParse(s) { try { return JSON.parse(s); } catch (_) { return s; } }

module.exports = {
  getDayBars, saveDayBars, hasDay, lastDayDate,
  get5minBars, save5minBars, has5min,
  getIntraday, saveIntraday, listIntradayDates, hasIntradayDate, hasIntraday,
  getNews, setNews,
  getCoverage, recordCoverage,
  closeStockDb,
};
