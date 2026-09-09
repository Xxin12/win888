'use strict';
/**
 * 回测策略库 (持久化到全局库 global.db)
 * ----------------------------------------------------------------
 * 两类策略:
 *   - type='code'   : 用户在页面编写的自定义 JS 策略 (js_code)
 *   - type='manual' : 用户在分时图手动标注的买卖点 (marks)
 * 两者均可在「我的策略库」中 运行 / 删除; 运行即把存储的 js_code/marks
 * 交给 engine 的 custom / manual 分支重新回测。
 */
const { globalDb } = require('../lib/db');

function safeParse(s) { try { return JSON.parse(s); } catch (_) { return null; } }

function ensure() {
  const db = globalDb();
  db.exec(`CREATE TABLE IF NOT EXISTS custom_strategies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL,                 -- 'code' | 'manual'
    stock_code TEXT,                   -- 适用股票(手动点标注时记录)
    js_code TEXT,                      -- type='code': 用户JS
    marks TEXT,                        -- type='manual': JSON[{date,time,price,type}]
    qty INTEGER,
    window_days INTEGER,
    summary TEXT,                      -- JSON 冗余快照 {trades,net,win_rate,days}
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
}

function list() {
  ensure();
  const rows = globalDb().prepare(
    'SELECT id,name,type,stock_code,js_code,marks,qty,window_days,summary,created_at FROM custom_strategies ORDER BY id DESC'
  ).all();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    stock_code: r.stock_code || '',
    js_code: r.js_code || '',
    marks: r.marks ? safeParse(r.marks) : [],
    qty: r.qty,
    windowDays: r.window_days,
    summary: r.summary ? safeParse(r.summary) : null,
    created_at: r.created_at,
  }));
}

function save(o) {
  ensure();
  const res = globalDb().prepare(
    `INSERT INTO custom_strategies(name,type,stock_code,js_code,marks,qty,window_days,summary,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,datetime('now','localtime'),datetime('now','localtime'))`
  ).run(
    o.name, o.type, o.stock_code || null, o.js_code || null,
    o.marks ? JSON.stringify(o.marks) : null, o.qty || null, o.windowDays || null,
    o.summary ? JSON.stringify(o.summary) : null
  );
  return res.lastInsertRowid;
}

function remove(id) {
  ensure();
  globalDb().prepare('DELETE FROM custom_strategies WHERE id=?').run(id);
}

module.exports = { ensure, list, save, remove };
