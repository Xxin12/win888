'use strict';
/**
 * 通用本地数据库浏览 / 编辑模块(本地数据查看器后端)。
 *
 * 设计目标: 让用户在前端直观浏览并管理本地 SQLite 存储 —— 既包含跨股票全局库
 * (data/db/global.db: 自选/持仓/预警/通知日志/覆盖索引/退市探针/回补队列/meta),
 * 也包含按股票代码隔离的个股库 (data/db/{code}.db: kline_day/kline_5min/intraday/news/meta)。
 *
 * 提供能力:
 *   - listStockDbs(): 列出已存在的个股 .db 文件(代码列表)
 *   - listTables(scope, code): 列出某库的所有表 + 字段结构(含主键标记) + 行数
 *   - getRows(scope, code, table, {page,pageSize,search}): 分页读取行(附带 _pk 供编辑/删除)
 *   - getRow(scope, code, table, pk): 按主键取单行
 *   - insertRow / updateRow / deleteRow: 增 / 改 / 删
 *
 * 安全边界:
 *   - 表名、代码均做白名单校验, 杜绝 SQL 注入(字段名直接拼接到 SQL)。
 *   - 写入时按字段声明的数值类型做 coerce: 空串 -> NULL, 数字串 -> Number, 避免写坏 REAL 列。
 *   - 个股库在"首次写入"时才创建文件(只读浏览不存在的代码不创建空库)。
 */
const fs = require('fs');
const { globalDb, stockDb, prefixOf, DB_DIR } = require('./db');

// 个股库模板(库文件尚不存在时也能渲染编辑器 + 兜底)
const STOCK_TABLES = {
  meta: { columns: [ { name: 'k', type: 'TEXT', pk: 1 }, { name: 'v', type: 'TEXT', pk: 0 } ] },
  kline_day: { columns: [
    { name: 'date', type: 'TEXT', pk: 1 }, { name: 'open', type: 'REAL', pk: 0 }, { name: 'high', type: 'REAL', pk: 0 },
    { name: 'low', type: 'REAL', pk: 0 }, { name: 'close', type: 'REAL', pk: 0 }, { name: 'volume', type: 'REAL', pk: 0 },
    { name: 'amount', type: 'REAL', pk: 0 }, { name: 'turnover', type: 'REAL', pk: 0 },
  ] },
  kline_5min: { columns: [
    { name: 'datetime', type: 'TEXT', pk: 1 }, { name: 'date', type: 'TEXT', pk: 0 }, { name: 'open', type: 'REAL', pk: 0 },
    { name: 'high', type: 'REAL', pk: 0 }, { name: 'low', type: 'REAL', pk: 0 }, { name: 'close', type: 'REAL', pk: 0 },
    { name: 'volume', type: 'REAL', pk: 0 }, { name: 'amount', type: 'REAL', pk: 0 },
  ] },
  intraday: { columns: [
    { name: 'date', type: 'TEXT', pk: 1 }, { name: 'time', type: 'TEXT', pk: 1 }, { name: 'price', type: 'REAL', pk: 0 },
    { name: 'avg', type: 'REAL', pk: 0 }, { name: 'volume', type: 'REAL', pk: 0 }, { name: 'cum_volume', type: 'REAL', pk: 0 },
  ] },
  news: { columns: [
    { name: 'ts', type: 'TEXT', pk: 1 }, { name: 'title', type: 'TEXT', pk: 0 }, { name: 'url', type: 'TEXT', pk: 0 },
    { name: 'raw', type: 'TEXT', pk: 0 },
  ] },
};

const VALID_TABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VALID_CODE = /^(sh|sz|bj)\d{6}$/;

function isNumericType(t) { return /INT|REAL|FLOAT|NUMBER|DOUBLE|DECIMAL|NUMERIC/i.test(t || ''); }

// 代码归一化: 6位数字 -> sh/sz/bj 前缀; 已带前缀直接接受; 否则抛错。
function normCode(code) {
  code = String(code || '').toLowerCase().trim();
  if (VALID_CODE.test(code)) return code;
  if (/^\d{6}$/.test(code)) return prefixOf(code) + code;
  throw new Error('非法股票代码(需 sh/sz/bj + 6位数字, 或 6位数字)');
}

function assertTable(table) {
  if (!table || !VALID_TABLE.test(table)) throw new Error('非法表名');
  return table;
}

// 只读打开(不存在不创建): global -> 全局库; stock -> 个股库(无则返回 null)
function openRead(scope, code) {
  if (scope === 'global') return globalDb();
  return stockDb(code, true); // readOnly
}
// 可写打开(不存在则创建文件, 用于写入): 个股库首次写入时建立
function openWrite(scope, code) {
  if (scope === 'global') return globalDb();
  return stockDb(code); // 可写
}

// 获取字段结构: 优先实时 PRAGMA; 个股库文件不存在时回退模板; 兜底 null
function getColumns(scope, code, table) {
  if (scope !== 'global' && STOCK_TABLES[table]) {
    const db = stockDb(code, true);
    if (db) {
      try { const info = db.prepare(`PRAGMA table_info("${table}")`).all(); if (info && info.length) return info.map((c) => ({ name: c.name, type: c.type || '', pk: c.pk })); } catch (_) { /* ignore */ }
    }
    return STOCK_TABLES[table].columns;
  }
  if (scope === 'global') {
    try { const info = globalDb().prepare(`PRAGMA table_info("${table}")`).all(); if (info && info.length) return info.map((c) => ({ name: c.name, type: c.type || '', pk: c.pk })); } catch (_) { /* ignore */ }
  }
  return null;
}

// 列出已存在个股 .db 文件的代码
function listStockDbs() {
  try {
    return fs.readdirSync(DB_DIR)
      .filter((f) => f.endsWith('.db') && f !== 'global.db')
      .map((f) => f.slice(0, -3))
      .sort();
  } catch (_) { return []; }
}

// 列出某库的表 + 字段 + 行数
function listTables(scope, code) {
  const out = [];
  if (scope === 'global') {
    const db = globalDb();
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
    for (const name of names) {
      const cols = getColumns('global', code, name) || [];
      let cnt = 0;
      try { const r = db.prepare(`SELECT COUNT(*) c FROM "${name}"`).get(); cnt = r ? r.c : 0; } catch (_) { /* ignore */ }
      out.push({ name, columns: cols, rowCount: cnt });
    }
    return out;
  }
  // 个股库
  const db = stockDb(code, true);
  let names;
  if (db) {
    names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
  } else {
    names = Object.keys(STOCK_TABLES); // 文件不存在: 展示模板表, 等用户首次写入再建库
  }
  for (const name of names) {
    const cols = getColumns('stock', code, name) || [];
    let cnt = 0;
    if (db) { try { const r = db.prepare(`SELECT COUNT(*) c FROM "${name}"`).get(); cnt = r ? r.c : 0; } catch (_) { /* ignore */ } }
    out.push({ name, columns: cols, rowCount: cnt });
  }
  return out;
}

// 分页读取行
function getRows(scope, code, table, opts = {}) {
  assertTable(table);
  const page = Math.max(1, parseInt(opts.page, 10) || 1);
  const pageSize = Math.min(500, Math.max(1, parseInt(opts.pageSize, 10) || 50));
  const db = openRead(scope, code);
  if (!db) return { columns: getColumns(scope, code, table) || [], rows: [], total: 0, page, pageSize, pkColumns: [] };
  const cols = getColumns(scope, code, table) || [];
  if (!cols.length) return { columns: [], rows: [], total: 0, page, pageSize, pkColumns: [] };
  const colNames = cols.map((c) => c.name);
  const safe = colNames.map((c) => `"${c}"`).join(',');
  const search = (opts.search || '').trim();
  let where = '';
  let params = [];
  if (search) {
    where = ' WHERE ' + colNames.map((c) => `CAST("${c}" AS TEXT) LIKE ?`).join(' OR ');
    params = colNames.map(() => `%${search}%`);
  }
  let total = 0;
  try { const r = db.prepare(`SELECT COUNT(*) c FROM "${table}"${where}`).get(...params); total = r ? r.c : 0; } catch (e) { total = 0; }
  const offset = (page - 1) * pageSize;
  let rows = [];
  try { rows = db.prepare(`SELECT ${safe} FROM "${table}"${where} LIMIT ? OFFSET ?`).all(...params, pageSize, offset); } catch (e) { rows = []; }
  const pkCols = cols.filter((c) => c.pk).map((c) => c.name);
  const rowsWithPk = rows.map((r) => { const pk = {}; pkCols.forEach((c) => (pk[c] = r[c])); return { ...r, _pk: pk }; });
  return { columns: cols, rows: rowsWithPk, total, page, pageSize, pkColumns: pkCols };
}

// 按主键取单行
function getRow(scope, code, table, pk) {
  assertTable(table);
  const db = openRead(scope, code);
  if (!db) return null;
  const cols = getColumns(scope, code, table) || [];
  const pkCols = cols.filter((c) => c.pk).map((c) => c.name);
  if (!pkCols.length) return null;
  const where = pkCols.map((c) => `"${c}"=?`).join(' AND ');
  const vals = pkCols.map((c) => (pk ? pk[c] : undefined));
  return db.prepare(`SELECT * FROM "${table}" WHERE ${where}`).get(...vals);
}

// 值 coerce: 空 -> NULL; 数值列 -> Number(NaN 退化为 NULL)
function coerce(col, val) {
  if (val === '' || val === null || val === undefined) return null;
  if (isNumericType(col.type)) {
    const n = Number(val);
    return isNaN(n) ? null : n;
  }
  return val;
}

// 写入前仅保留已知列
function pickCols(cols, values) {
  const names = cols.map((c) => c.name);
  return cols.filter((c) => names.includes(c.name) && (c.name in (values || {})));
}

// 新增一行
function insertRow(scope, code, table, values) {
  assertTable(table);
  const db = openWrite(scope, code);
  const cols = getColumns(scope, code, table) || [];
  if (!cols.length) throw new Error('无法识别表结构');
  const defs = pickCols(cols, values);
  if (!defs.length) throw new Error('无可写入字段');
  const names = defs.map((c) => `"${c.name}"`);
  const params = defs.map((c) => coerce(c, (values || {})[c.name]));
  const ph = defs.map(() => '?').join(',');
  db.prepare(`INSERT INTO "${table}" (${names.join(',')}) VALUES (${ph})`).run(...params);
  return { ok: true, inserted: defs.length };
}

// 更新一行(按主键定位)
function updateRow(scope, code, table, pk, values) {
  assertTable(table);
  const db = openWrite(scope, code);
  const cols = getColumns(scope, code, table) || [];
  if (!cols.length) throw new Error('无法识别表结构');
  const pkCols = cols.filter((c) => c.pk).map((c) => c.name);
  if (!pkCols.length) throw new Error('该表无主键, 无法定位更新');
  const setCols = cols.filter((c) => !c.pk && (c.name in (values || {})));
  if (!setCols.length) return { ok: true, changed: 0 };
  const sets = setCols.map((c) => `"${c.name}"=?`).join(',');
  const params = setCols.map((c) => coerce(c, (values || {})[c.name]));
  const where = pkCols.map((c) => `"${c}"=?`).join(' AND ');
  const whereParams = pkCols.map((c) => (pk ? pk[c] : undefined));
  const info = db.prepare(`UPDATE "${table}" SET ${sets} WHERE ${where}`).run(...params, ...whereParams);
  return { ok: true, changed: info.changes };
}

// 删除一行(按主键定位)
function deleteRow(scope, code, table, pk) {
  assertTable(table);
  const db = openWrite(scope, code);
  const cols = getColumns(scope, code, table) || [];
  const pkCols = cols.filter((c) => c.pk).map((c) => c.name);
  if (!pkCols.length) throw new Error('该表无主键, 无法删除');
  const where = pkCols.map((c) => `"${c}"=?`).join(' AND ');
  const whereParams = pkCols.map((c) => (pk ? pk[c] : undefined));
  const info = db.prepare(`DELETE FROM "${table}" WHERE ${where}`).run(...whereParams);
  return { ok: true, changes: info.changes };
}

module.exports = {
  normCode, listStockDbs, listTables, getRows, getRow, insertRow, updateRow, deleteRow,
};
