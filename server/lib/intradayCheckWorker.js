'use strict';
/**
 * 分时"本地是否有数据"判断 —— worker 线程执行体(多线程判断的工作单元)。
 *
 * 背景: 逐只打开 data/db/{code}.db 判断 intraday 表是否有数据, 单库开销大(WAL 打开 ~百毫秒/库),
 *       全市场顺序判断会很慢。故对"无覆盖索引可依据"的不确定子集, 拆分到多个 worker 并行判断。
 * 契约: 主线程通过 workerData 传入 { dbDir, codes }; 本 worker 返回 { has: string[] }(本地确有分时的代码)。
 * 边界: 仅做"有无分时"的判断(只读 SELECT), 不写任何数据、不触发回补。
 */
const { workerData, parentPort } = require('worker_threads');
const path = require('path');
const fs = require('fs');

const has = [];
try {
  const { DatabaseSync } = require('node:sqlite');
  const { dbDir, codes } = workerData || {};
  for (const code of (codes || [])) {
    const file = path.join(dbDir, `${code}.db`);
    if (!fs.existsSync(file)) continue; // 无库文件 = 无任何数据, 快速短路
    let db = null;
    try {
      // 正常(可读写)方式打开: 避免只读打开 WAL 库的极慢路径; 本 worker 只执行 SELECT, 不写入。
      db = new DatabaseSync(file);
      if (db.prepare('SELECT 1 FROM intraday LIMIT 1').get()) has.push(code);
    } catch (_) {
      // 表缺失 / 打开失败 → 视为无分时(交由回补队列处理), 不中断整体
    } finally {
      if (db) { try { db.close(); } catch (_) { /* ignore */ } }
    }
  }
} catch (_) { /* node:sqlite 不可用等极端情况: 返回空, 主线程回退顺序判断 */ }

if (parentPort) parentPort.postMessage({ has });
