'use strict';
const fs = require('fs');

/** 读取规范CSV(首行表头)，返回对象数组，数值列自动转float */
function readCsv(file, numCols = []) {
  if (!fs.existsSync(file)) return [];
  const txt = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const lines = txt.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return [];
  const head = lines[0].split(',').map((s) => s.trim());
  const numSet = new Set(numCols);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    const o = {};
    head.forEach((h, j) => {
      let v = (cells[j] ?? '').trim();
      o[h] = numSet.has(h) ? parseFloat(v) : v;
    });
    rows.push(o);
  }
  return rows;
}

/** 读5分钟K线 (fzme格式) */
function read5min(file) {
  return readCsv(file, ['open', 'high', 'low', 'close', 'volume', 'amount']);
}

/** 读日K (含 amount成交额/ turnover换手率, 旧6列文件缺省为0) */
function readDay(file) {
  return readCsv(file, ['open', 'high', 'low', 'close', 'volume', 'amount', 'turnover']);
}

/** 写日K CSV (8列: 含成交额/换手率) */
function writeDay(file, rows) {
  const head = 'date,open,high,low,close,volume,amount,turnover';
  const body = rows
    .map((r) => [r.date, r.open, r.high, r.low, r.close, r.volume, r.amount || 0, r.turnover || 0].join(','))
    .join('\n');
  fs.writeFileSync(file, head + '\n' + body + '\n', 'utf8');
}

/** 写5分钟K线 CSV (fzme格式: datetime,date,open,high,low,close,volume,amount) */
function write5min(file, rows) {
  const head = 'datetime,date,open,high,low,close,volume,amount';
  const body = rows
    .map((r) => [r.datetime, r.date, r.open, r.high, r.low, r.close, r.volume, r.amount || 0].join(','))
    .join('\n');
  fs.writeFileSync(file, head + '\n' + body + '\n', 'utf8');
}

/** 读当日分时落盘文件 -> [{t,price,avg,volume,cumVolume}] (与 tencent.getMinute 返回结构一致) */
function readIntraday(file) {
  return readCsv(file, ['price', 'avg', 'volume', 'cum_volume']).map((r) => ({
    t: r.time, price: r.price, avg: r.avg, volume: r.volume, cumVolume: r.cum_volume,
  }));
}

/** 写当日分时落盘 CSV (列: time,price,avg,volume,cum_volume) */
function writeIntraday(file, rows) {
  const head = 'time,price,avg,volume,cum_volume';
  const body = rows
    .map((r) => [r.t || r.time, r.price, r.avg, r.volume, r.cumVolume ?? r.cum_volume].join(','))
    .join('\n');
  fs.writeFileSync(file, head + '\n' + body + '\n', 'utf8');
}

module.exports = { readCsv, read5min, readDay, writeDay, write5min, readIntraday, writeIntraday };
