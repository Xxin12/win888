// API 客户端
const BASE = '';
async function get(url) {
  const r = await fetch(BASE + url);
  return r.json();
}
async function post(url, body) {
  const r = await fetch(BASE + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json();
}
async function del(url) {
  const r = await fetch(BASE + url, { method: 'DELETE' });
  return r.json();
}

export const api = {
  quote: (codes) => get('/api/quote?codes=' + codes.join(',')),
  kline: (code, period, limit) => get(`/api/kline?code=${code}&period=${period}${limit ? '&limit=' + limit : ''}`),
  indicators: (code, period, types, limit) => get(`/api/indicators?code=${code}&period=${period}&types=${types.join(',')}${limit ? '&limit=' + limit : ''}`),
  minute: (code, date) => get('/api/minute?code=' + code + (date ? '&date=' + date : '')),
  intradayDates: (code) => get('/api/intraday/dates?code=' + code),
  intradayCompare: (code, date) => get('/api/intraday/compare?code=' + encodeURIComponent(code) + (date ? '&date=' + encodeURIComponent(date) : '')),
  intradayBackfill: (code, days, source, range) => post('/api/intraday/backfill', { code, days, source, ...(range && range.start && range.end ? { start: range.start, end: range.end } : {}) }),
  intradayBackfillProgress: (code) => get('/api/intraday/backfill/progress?code=' + encodeURIComponent(code)),
  // 行情中心: A股全市场列表 + 批量回补
  stocks: () => get('/api/stocks'),
  stocksRefresh: () => post('/api/stocks/refresh', {}),
  indices: () => get('/api/indices'),
  stocksCoverage: (codes) => get('/api/stocks/coverage?codes=' + codes.join(',')),
  stocksCoverageAll: () => get('/api/stocks/coverage-all'),
  backfillBulk: (o) => post('/api/backfill-bulk', o),
  backfillBulkStatus: () => get('/api/backfill-bulk/status'),
  watchlist: () => get('/api/watchlist'),
  addWatch: (o) => post('/api/watchlist', o),
  delWatch: (code) => del('/api/watchlist/' + code),
  alerts: () => get('/api/alerts'),
  addAlert: (o) => post('/api/alerts', o),
  delAlert: (id) => del('/api/alerts/' + id),
  evalAlerts: () => get('/api/alerts/evaluate'),
  backtest: (o) => post('/api/backtest', o),
  importDayline: (o) => post('/api/import/dayline', o),
  getDividend: (code) => get('/api/dividend/' + encodeURIComponent(code)),
  backtestDay: (code, date) => get('/api/backtest/day?code=' + encodeURIComponent(code) + '&date=' + encodeURIComponent(date)),
  backtestDates: (code, intradayOnly) => get('/api/backtest/dates?code=' + encodeURIComponent(code) + (intradayOnly ? '&intraday=1' : '')).then((r) => (intradayOnly ? (r.intraday || []) : (r.dates || []))),
  backtestStrategies: () => get('/api/backtest/strategies'),
  saveBacktestStrategy: (o) => post('/api/backtest/strategies', o),
  deleteBacktestStrategy: (id) => del('/api/backtest/strategies?id=' + id),
  portfolio: () => get('/api/portfolio'),
  savePortfolio: (list) => post('/api/portfolio', list),
  f10: (code) => get('/api/f10?code=' + code),
  fundflow: (code) => get('/api/fundflow?code=' + code),
  news: (code) => get('/api/news?code=' + code),
  wecomConfig: () => get('/api/wecom-config'),
  saveWecomConfig: (o) => post('/api/wecom-config', o),
  notify: (o) => post('/api/notify', o),
  tdxGatewayConfig: () => get('/api/tdx-gateway/config'),
  saveTdxGatewayConfig: (o) => post('/api/tdx-gateway/config', o),
  startTdxGateway: () => post('/api/tdx-gateway/start'),
  stopTdxGateway: () => post('/api/tdx-gateway/stop'),
  tdxGatewayStatus: () => get('/api/tdx-gateway/status'),
  tdxGatewayDeps: () => get('/api/tdx-gateway/deps'),
  dataSourceConfig: () => get('/api/datasource/config'),
  saveDataSourceConfig: (o) => post('/api/datasource/config', o),
  dataSourceTest: (code) => get('/api/datasource/test?code=' + encodeURIComponent(code || '')),
  resolve: (code) => get('/api/stock/resolve?code=' + encodeURIComponent(code)),
  ping: () => get('/api/ping'),
  systemRestart: () => post('/api/system/restart', {}),
  // 每日行情数据补齐
  dailySyncStatus: () => get('/api/daily-sync/status'),
  dailySyncRun: (o) => post('/api/daily-sync', o || {}),
  // 日内做T分析
  dotAnalyze: (code) => get('/api/dot/analyze?code=' + encodeURIComponent(code)),
  dotDay: (code, date) => get('/api/dot/day?code=' + encodeURIComponent(code) + '&date=' + encodeURIComponent(date)),
  dotCompare: (codes) => get('/api/dot/compare?codes=' + codes.map((c) => encodeURIComponent(c)).join(',')),
  dotBacktest: (code) => get('/api/dot/backtest?code=' + encodeURIComponent(code)),
  dotThresholds: () => get('/api/dot/thresholds'),
  dotSaveThresholds: (o) => post('/api/dot/thresholds', o),
  dotNotifyToday: (code) => post('/api/dot/notify-today', { code }),
  dotTopsBottoms: (code, date) => get('/api/dot/tops-bottoms?code=' + encodeURIComponent(code) + (date ? '&date=' + encodeURIComponent(date) : '')),
  dotReplay: (code, date, pattern) => get('/api/dot/replay?code=' + encodeURIComponent(code) + '&date=' + encodeURIComponent(date) + (pattern ? '&pattern=1' : '')),
  // 本地数据库浏览 / 编辑
  dbStocks: () => get('/api/db/stocks'),
  dbTables: (scope, code) => get('/api/db/tables?scope=' + scope + (code ? '&code=' + encodeURIComponent(code) : '')),
  dbRows: (scope, code, table, page, pageSize, search) => get('/api/db/rows?scope=' + scope + (code ? '&code=' + encodeURIComponent(code) : '') + '&table=' + encodeURIComponent(table || '') + '&page=' + (page || 1) + '&pageSize=' + (pageSize || 50) + (search ? '&search=' + encodeURIComponent(search) : '')),
  dbInsert: (scope, code, table, values) => post('/api/db/row', { scope, code, table, values }),
  dbUpdate: (scope, code, table, pk, values) => { const b = { scope, code, table, pk, values }; return fetch(BASE + '/api/db/row', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json()); },
  dbDelete: (scope, code, table, pk) => post('/api/db/row/delete', { scope, code, table, pk }),
};

// 客户端代码归一化(与后端 tencent.normCode 一致): 6位数字 -> sh/sz/bj 前缀
export function normCode(code) {
  code = String(code || '').toLowerCase().trim();
  if (/^(sh|sz|bj)\d{6}$/.test(code)) return code;
  if (/^\d{6}$/.test(code)) {
    if (code[0] === '6') return 'sh' + code;
    if (code[0] === '8' || code[0] === '4') return 'bj' + code;
    return 'sz' + code;
  }
  return code;
}

// WebSocket 实时行情
export function connectQuotes(onMsg) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let ws, timer;
  const pending = []; // 连接未就绪时缓冲订阅, onopen 后统一发送(避免订阅消息被丢弃)
  const send = (obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); else pending.push(obj); };
  const open = () => {
    ws = new WebSocket(`${proto}://${location.host}/ws/quotes`);
    ws.onmessage = (e) => { try { onMsg(JSON.parse(e.data)); } catch (_) {} };
    ws.onopen = () => { while (pending.length) ws.send(JSON.stringify(pending.shift())); };
    ws.onclose = () => { timer = setTimeout(open, 3000); }; // 断线重连
    ws.onerror = () => ws.close();
  };
  open();
  return {
    subscribe: (codes) => send({ type: 'subscribe', codes }),
    close: () => { clearTimeout(timer); if (ws) { ws.onclose = null; ws.close(); } },
  };
}

export const fmt = {
  price: (v) => (v == null ? '--' : Number(v).toFixed(2)),
  pct: (v) => (v == null ? '--' : (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%'),
  money: (v) => (v == null ? '--' : '¥' + Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 })),
  cls: (v) => (v > 0 ? 'up' : v < 0 ? 'down' : ''),
};
