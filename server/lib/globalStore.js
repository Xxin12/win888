'use strict';
/**
 * 全局/跨股票状态存储层(底层为 data/db/global.db)。
 * 覆盖: 股票池(universe) / 自选(watchlist) / 持仓(portfolio) / 预警(alert) / 通知日志(notify_log)。
 * 原 watchlist.json / portfolio.json / alerts.json / notify-log.json 的读写, 全部改走本模块。
 */
const fs = require('fs');
const path = require('path');
const { globalDb, txn, stockDb, DB_DIR } = require('./db');

// ---------------- 股票池 ----------------
function upsertStocks(stocks) {
  if (!stocks || !stocks.length) return 0;
  const db = globalDb();
  const ins = db.prepare('INSERT OR REPLACE INTO stock(code,name,market,updated_at) VALUES(?,?,?,?)');
  const insCov = db.prepare('INSERT OR IGNORE INTO stock_coverage(code,has_day,has_5min,intraday_dates,scanned) VALUES(?,0,0,0,1)');
  txn(db, (rows) => {
    for (const s of rows) { ins.run(s.code, s.name, s.market, s.updated_at || new Date().toISOString()); insCov.run(s.code); }
  }, stocks);
  return stocks.length;
}
function getStocks() { return globalDb().prepare('SELECT code,name,market FROM stock').all(); }
function countStocks() { const r = globalDb().prepare('SELECT COUNT(*) c FROM stock').get(); return r ? r.c : 0; }

// ---------------- 回补覆盖情况(stock_coverage) ----------------
// 每只股票回补落盘后由 marketStore.recordCoverage 写入; 行情中心 /api/stocks/coverage 直接按 code IN (...) 批量查,
// 不必再为每页 50 只股票各打开一个独立 .db 文件。启动时为全市场股票 seed 默认行(全 0)。
function ensureCoverage(code) {
  globalDb().prepare('INSERT OR IGNORE INTO stock_coverage(code,has_day,has_5min,intraday_dates,scanned) VALUES(?,0,0,0,1)').run(code);
}
function upsertCoverage(code, { hasDay, has5min, intradayDates, lastDayDate, last5minDate }) {
  globalDb().prepare(
    `INSERT INTO stock_coverage(code,has_day,has_5min,intraday_dates,last_day_date,last_5min_date,last_backfill,scanned)
     VALUES(?,?,?,?,?,?,?,1)
     ON CONFLICT(code) DO UPDATE SET
       has_day=excluded.has_day, has_5min=excluded.has_5min, intraday_dates=excluded.intraday_dates,
       last_day_date=excluded.last_day_date, last_5min_date=excluded.last_5min_date,
       last_backfill=excluded.last_backfill, scanned=1`
  ).run(code, hasDay ? 1 : 0, has5min ? 1 : 0, intradayDates || 0, lastDayDate || null, last5minDate || null, new Date().toISOString());
}
function getCoverageMap(codes) {
  const map = new Map();
  const list = (codes || []).map(String).filter(Boolean);
  if (!list.length) return map;
  const db = globalDb();
  const placeholders = list.map(() => '?').join(',');
  const rows = db.prepare(`SELECT code,has_day,has_5min,intraday_dates FROM stock_coverage WHERE code IN (${placeholders})`).all(...list);
  for (const r of rows) map.set(r.code, { hasDay: r.has_day, has5min: r.has_5min, intradayDates: r.intraday_dates });
  return map;
}
// 快速路径(启动用, 毫秒级): 保证 stock 表每只股票在 stock_coverage 都有一行(缺失补 0),
// 纯 SQL 不打开任何单只 .db 文件。已存在的行(含真值)不受影响(INSERT OR IGNORE)。
function ensureAllCoverageRows() {
  const db = globalDb();
  const codes = db.prepare('SELECT code FROM stock').all().map((r) => r.code);
  if (!codes.length) return 0;
  const ins0 = db.prepare('INSERT OR IGNORE INTO stock_coverage(code,has_day,has_5min,intraday_dates,scanned) VALUES(?,0,0,0,1)');
  txn(db, (rows) => { for (const c of rows) ins0.run(c); }, codes);
  return codes.length;
}
function countCoverage() { const r = globalDb().prepare('SELECT COUNT(*) c FROM stock_coverage').get(); return r ? r.c : 0; }
// 全量覆盖索引(行情中心"无本地数据"筛选用): 一次性 SELECT 全表, 单条 SQL 毫秒级。
// 返回 { code: { has5min, hasDay, intradayDates } }, 每只股票都有行(启动时 ensureAllCoverageRows 已补 0)。
function getAllCoverage() {
  const db = globalDb();
  const rows = db.prepare('SELECT code,has_day,has_5min,intraday_dates FROM stock_coverage').all();
  const map = {};
  for (const r of rows) map[r.code] = { has5min: !!r.has_5min, hasDay: !!r.has_day, intradayDates: r.intraday_dates || 0 };
  return map;
}

// ---------------- 退市探针结果(stock_delist_probe) ----------------
// 行情中心退市判定 = 名称含"退"字(离线) ∪ 腾讯 qt 字段[40]='D'(后台探针, 覆盖名称不含退的退市股如 600001 邯郸钢铁)。
// 探针在启动时后台批量跑 getQuotes, 命中 [40]='D' 的落库, 列表加载时一次性读成 Set 参与判定。
function saveDelistedProbe(code, reason) {
  globalDb().prepare('INSERT OR REPLACE INTO stock_delist_probe(code,delisted,reason,probed_at) VALUES(?,1,?,?)')
    .run(code, reason || 'qt_status_D', new Date().toISOString());
}
function getDelistedProbeSet() {
  const set = new Set();
  const rows = globalDb().prepare('SELECT code FROM stock_delist_probe WHERE delisted=1').all();
  for (const r of rows) set.add(r.code);
  return set;
}
function clearDelistProbe() { globalDb().prepare('DELETE FROM stock_delist_probe').run(); }

// 重建回补覆盖真值: 扫描有 data/db/{code}.db 文件的股票, 计算 hasDay/has5min/intradayDates 并 upsert。
// 分块(每 CHUNK 只)让出事件循环, 可安全在后台运行而不阻塞 HTTP 服务; 仅在覆盖表为空(首次迁移)时调用。
// 注意: 本函数不负责补 0(由 ensureAllCoverageRows 完成), 这里只给有库文件的股票写真值。
async function seedCoverageFromStocks() {
  const db = globalDb();
  const codes = db.prepare('SELECT code FROM stock').all().map((r) => r.code);
  if (!codes.length) return { total: 0, computed: 0, zero: 0 };
  const haveDb = new Set();
  try { for (const f of fs.readdirSync(DB_DIR)) { if (f.endsWith('.db') && f !== 'global.db') haveDb.add(f.slice(0, -3)); } } catch (_) { /* ignore */ }
  const ups = db.prepare(
    `INSERT INTO stock_coverage(code,has_day,has_5min,intraday_dates,last_day_date,last_5min_date,last_backfill,scanned)
     VALUES(?,?,?,?,?,?,?,1)
     ON CONFLICT(code) DO UPDATE SET
       has_day=excluded.has_day, has_5min=excluded.has_5min, intraday_dates=excluded.intraday_dates,
       last_day_date=excluded.last_day_date, last_5min_date=excluded.last_5min_date,
       last_backfill=excluded.last_backfill, scanned=1`
  );
  const now = new Date().toISOString();
  const CHUNK = 40;
  let computed = 0;
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const sdb = haveDb.has(code) ? stockDb(code, true) : null;
    if (!sdb) continue; // 无 .db 文件: 已由 ensureAllCoverageRows 补 0
    const hasDay = sdb.prepare('SELECT 1 FROM kline_day LIMIT 1').get() ? 1 : 0;
    const has5min = sdb.prepare('SELECT 1 FROM kline_5min LIMIT 1').get() ? 1 : 0;
    const intradayDates = (sdb.prepare('SELECT COUNT(DISTINCT date) c FROM intraday').get().c) || 0;
    const lastDayDate = (() => { const r = sdb.prepare('SELECT MAX(date) d FROM kline_day').get(); return r && r.d ? r.d : null; })();
    const last5minDate = (() => { const r = sdb.prepare('SELECT MAX(date) d FROM kline_5min').get(); return r && r.d ? r.d : null; })();
    ups.run(code, hasDay, has5min, intradayDates, lastDayDate, last5minDate, now);
    computed++;
    if (i % CHUNK === CHUNK - 1) await new Promise((r) => setImmediate(r)); // 让出事件循环, 不阻塞服务
  }
  return { total: codes.length, computed, zero: codes.length - computed };
}

// ---------------- 自选 ----------------
function getWatchlist() { return globalDb().prepare('SELECT code,name,grp FROM watchlist ORDER BY rowid').all(); }
function addWatchlist({ code, name, group }) {
  globalDb().prepare('INSERT OR REPLACE INTO watchlist(code,name,grp) VALUES(?,?,?)').run(code, name, group || '默认');
}
function removeWatchlist(code) { globalDb().prepare('DELETE FROM watchlist WHERE code=?').run(code); }

// ---------------- 持仓 ----------------
function getPortfolio() { return globalDb().prepare('SELECT id,code,name,shares,cost,note FROM portfolio ORDER BY id').all(); }
function setPortfolio(list) {
  const db = globalDb();
  const del = db.prepare('DELETE FROM portfolio');
  const ins = db.prepare('INSERT INTO portfolio(code,name,shares,cost,note) VALUES(?,?,?,?,?)');
  txn(db, (rows) => {
    del.run();
    for (const x of (rows || [])) ins.run(x.code, x.name || '', x.shares, x.cost, x.note || '');
  }, list);
}

// ---------------- 预警 ----------------
function getAlerts() {
  return globalDb().prepare('SELECT id,code,type,op,value,note,enabled,triggered,last_hit FROM alert ORDER BY id').all()
    .map((a) => ({ ...a, enabled: !!a.enabled, triggered: !!a.triggered }));
}
function addAlert(a) {
  return globalDb().prepare('INSERT INTO alert(code,type,op,value,note,enabled,triggered,last_hit) VALUES(?,?,?,?,?,?,?,?)')
    .run(a.code, a.type, a.op, a.value, a.note || '', a.enabled !== false ? 1 : 0, 0, null);
}
function removeAlert(id) { globalDb().prepare('DELETE FROM alert WHERE id=?').run(id); }
function updateAlerts(list) {
  const db = globalDb();
  const upd = db.prepare('UPDATE alert SET code=?,type=?,op=?,value=?,note=?,enabled=?,triggered=?,last_hit=? WHERE id=?');
  txn(db, (rows) => {
    for (const a of rows) upd.run(a.code, a.type, a.op, a.value, a.note || '', a.enabled ? 1 : 0, a.triggered ? 1 : 0, a.last_hit || null, a.id);
  }, list);
}

// ---------------- 通知日志 ----------------
// 兼容旧库: notify_log 可能缺少 sig_key 列(统一去重键), 首次写日志时补列(重复列忽略)
let _sigKeyColReady = false;
function ensureSigKeyCol() {
  if (_sigKeyColReady) return;
  try { globalDb().exec('ALTER TABLE notify_log ADD COLUMN sig_key TEXT'); } catch (_) { /* 已存在则忽略 */ }
  _sigKeyColReady = true;
}
function appendNotifyLog(entry) {
  ensureSigKeyCol();
  globalDb().prepare('INSERT INTO notify_log(ts,type,code,name,detail,sig_key) VALUES(?,?,?,?,?,?)')
    .run(entry.time || new Date().toISOString(), entry.type || null, entry.code || null, entry.name || null,
      JSON.stringify(entry), entry.sigKey || null);
}
function getNotifyLog(limit = 200) {
  return globalDb().prepare('SELECT * FROM notify_log ORDER BY id DESC LIMIT ?').all(limit);
}
// 统一去重: 检查该信号是否已在 notify_log 中存在(前端已带截图发送, 则服务端兜底扫描跳过)
// sigKey 形如 code|YYYY-MM-DD|type|HH:MM:SS(与 wecom.sendNotify 写入的一致)
function existsNotifyLog(sigKey) {
  if (!sigKey) return false;
  try {
    const row = globalDb().prepare('SELECT 1 FROM notify_log WHERE sig_key=? LIMIT 1').get(sigKey);
    return !!row;
  } catch (_) {
    // 列尚未就绪(极端情况): 退化为按 code+type+ts 前缀匹配, 避免兜底重复推送
    try {
      const rows = globalDb().prepare('SELECT ts,type,code FROM notify_log WHERE code=? AND type=? ORDER BY id DESC LIMIT 50').all(
        String(sigKey).split('|')[0], String(sigKey).split('|')[2]);
      return rows.some((r) => (r.ts || '').slice(0, 10) === String(sigKey).split('|')[1]);
    } catch (_) { return false; }
  }
}

module.exports = {
  upsertStocks, getStocks, countStocks,
  ensureCoverage, upsertCoverage, getCoverageMap, seedCoverageFromStocks, ensureAllCoverageRows, countCoverage, getAllCoverage,
  saveDelistedProbe, getDelistedProbeSet, clearDelistProbe,
  getWatchlist, addWatchlist, removeWatchlist,
  getPortfolio, setPortfolio,
  getAlerts, addAlert, removeAlert, updateAlerts,
  appendNotifyLog, getNotifyLog, existsNotifyLog,
  saveDividends, getDividends,
};

// ---------------- 分红/转增(红利再投用) ----------------
// 数据来源: 新浪分红融资页(公开、无鉴权)。仅保存"实施"进度的分红事件。
// cash_per_share = 每股派息(元, 税前); bonus_per_share = 每股送股; transfer_per_share = 每股转增。
function saveDividends(code, list) {
  if (!code || !list || !list.length) return 0;
  const db = globalDb();
  const ins = db.prepare(
    `INSERT OR REPLACE INTO dividend(code,ex_date,cash_per_share,bonus_per_share,transfer_per_share,progress,fetched_at)
     VALUES(?,?,?,?,?,?,?)`
  );
  txn(db, (rows) => {
    for (const d of rows) {
      ins.run(code, d.exDate, d.cashPerShare || 0, d.bonusPerShare || 0, d.transferPerShare || 0, d.progress || '实施', new Date().toISOString());
    }
  }, list);
  return list.length;
}
function getDividends(code) {
  if (!code) return [];
  return globalDb().prepare(
    'SELECT ex_date exDate, cash_per_share cashPerShare, bonus_per_share bonusPerShare, transfer_per_share transferPerShare, progress FROM dividend WHERE code=? ORDER BY ex_date'
  ).all(code);
}
