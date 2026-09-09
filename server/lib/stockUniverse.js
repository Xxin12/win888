'use strict';
/**
 * A股全市场股票列表(行情中心"收录所有股票"的数据底座)
 *
 * 来源可配置(server/lib/dataSource.js 的 `universe` 项):
 *   - 'tdx' (默认): 通达信网关枚举全市场。经 pytdx get_security_list(category==1=股票)
 *       一次性枚举沪深京全部 A股, 与「回补分时行情」同一套设计 —— 可插拔 provider(网关)、
 *       本地快照优先、全局限流、网关不可达时优雅降级回本地快照。需在「🧩 TDX 网关」页启动网关
 *       (默认随系统启动)。成功抓取写本地快照 CSV(data/stocks_universe_local.csv), 供离线/降级使用。
 *       ⚠️ 实测: TDX 公共行情节点普遍 get_security_list 返回空(仅券商自建服务器提供该接口),
 *       代码无法修复 → 自动降级到下方 'tencent' 探测源。
 *   - 'tencent' (兜底, 推荐在无东财/TDX列表时显式选择): 用腾讯 qt.gtimg.cn 批量报价接口,
 *       按 A股代码段规则(sh600/601/603/605/688/689, sz000/001/002/003/300/301, bj83/87/88/89/92)
 *       生成候选 6 位代码, 批量探测反推有效股票(code+name)。行情接口在本环境确认可用,
 *       完全不依赖被墙的东财 push2 与受限的 TDX 列表接口。同样写本地快照。约1.7万候选一次性探测(~1分钟)。
 *   - 'eastmoney': 东财 clist 接口(沪深京A股全量, 无需网关/鉴权); 主机可被「东财节点(emNode)」覆盖。
 *       成功抓取同样写本地快照。东财 push2 在部分网络被拦截时不可用。
 *   - 'local': 直接读取本地快照 CSV, 东财/TDX/腾讯 不可用时仍能展示全市场列表。
 *
 * 设计要点(对齐「回补分时行情」):
 *   - 可插拔: universe 可切 tdx/tencent/eastmoney/local, 各自 provider 实现 fetchFromXxx。
 *   - 本地优先: 任何模式成功抓取都会写快照; 之后读取优先本地(快、省网络)。
 *   - 全局限流: 每次向 TDX 网关发起请求前经 backfillRate.acquire()(每秒最多1次), 与回补共用闸门。
 *   - 优雅降级: TDX 空/失败 → 自动尝试腾讯探测 → 仍失败才回退本地快照; 连快照都没有才报错。
 */
const fs = require('fs');
const path = require('path');
const { DATA } = require('./store');
const { readConfig, emHost } = require('./dataSource');
const rate = require('./backfillRate'); // 全局请求限流(每秒最多1次), 与回补共用闸门
const { getQuotes } = require('../providers/tencent'); // 腾讯批量报价(GBK解码), 用于探测枚举
const gstore = require('./globalStore');                 // 股票池落库(global.db)
const { setMeta, getMeta } = require('./db');            // 列表抓取元信息(universe_source/updated)

const CACHE_PATH = path.join(DATA, 'stocks_universe.json');        // 各源统一缓存(json)
const SNAPSHOT_PATH = path.join(DATA, 'stocks_universe_local.csv'); // 本地快照(csv, 供 local/降级模式)
const INDUSTRY_MAP_PATH = path.join(DATA, 'industry_map.json');    // 行业映射: {code: 行业名}(由 TDX 回补生成)

// 行业映射(静态参考文件, 由 tdx_screener 批量回补写入 data/industry_map.json)
let _industryMap = null;
let _industryMapMtime = 0;
function getIndustryMap() {
  try {
    if (!fs.existsSync(INDUSTRY_MAP_PATH)) return _industryMap || {};
    const mtime = fs.statSync(INDUSTRY_MAP_PATH).mtimeMs;
    if (_industryMap && mtime === _industryMapMtime) return _industryMap;
    _industryMap = JSON.parse(fs.readFileSync(INDUSTRY_MAP_PATH, 'utf8'));
    _industryMapMtime = mtime;
    return _industryMap;
  } catch (_) { return _industryMap || {}; }
}

// 东财全A股筛选: 沪市(m:0+t:6)、深市(m:0+t:80)、深市主板/创业板(m:1+t:2)、京市/北交所(m:1+t:23)
const EM_PATH = '/api/qt/clist/get?pn=1&pz=6000&fid=f3&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=f12,f13,f14';

// f13: 1=沪 0=深 2=京; 兜底按首位代码判定
function marketPrefix(f13, code) {
  if (f13 === 1) return 'sh';
  if (f13 === 2) return 'bj';
  if (f13 === 0) return 'sz';
  const c = String(code || '');
  if (c[0] === '6' || c[0] === '9') return 'sh';
  if (c[0] === '8' || c[0] === '4') return 'bj';
  return 'sz';
}

function emClistUrl() {
  const host = emHost() || 'push2.eastmoney.com';
  return 'https://' + host + EM_PATH;
}

async function fetchFromEm() {
  const r = await fetch(emClistUrl(), { headers: { 'User-Agent': 'quant-web/1.0' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const diff = (j && j.data && j.data.diff) || [];
  return diff
    .map((d) => {
      const code = marketPrefix(d.f13, d.f12) + String(d.f12 || '');
      return { code, name: d.f14 || d.f12 || code, market: marketPrefix(d.f13, d.f12) };
    })
    .filter((s) => /^(sh|sz|bj)\d{6}$/.test(s.code));
}

// ---- TDX 网关股票池枚举 ----
function tdxEndpoint() { return (process.env.TDX_ENDPOINT || '').replace(/\/+$/, ''); }
function tdxToken() { return (process.env.TDX_TOKEN || '').trim(); }

async function fetchFromTdx() {
  const ep = tdxEndpoint();
  if (!ep) throw new Error('TDX_ENDPOINT 未配置：请在「🧩 TDX 网关」页启动网关(默认随系统启动)');
  await rate.acquire(); // 全局限流: 与回补共用同一道闸门(每次请求前 acquire)
  const headers = { 'User-Agent': 'quant-web/1.0' };
  const tok = tdxToken();
  if (tok) headers.Authorization = 'Bearer ' + tok;
  const r = await fetch(ep + '/stocks', { headers });
  if (!r.ok) throw new Error('网关 HTTP ' + r.status);
  const j = await r.json();
  if (!j || !j.ok) throw new Error((j && j.reason) ? j.reason : '网关返回失败');
  const stocks = (j.stocks || [])
    .map((s) => ({ code: s.code, name: s.name, market: s.market }))
    .filter((s) => /^(sh|sz|bj)\d{6}$/.test(s.code));
  return stocks;
}

// ---- 腾讯报价探测枚举(全市场兜底源) ----
// TDX 公共节点 get_security_list 普遍返回空、东财 push2 被拦截时, 用腾讯 qt.gtimg.cn 批量报价
// 接口探测【所有可能的 A股代码段】, 反推有效股票(code+name)。行情接口在本环境确认可用,
// 完全不依赖东财/TDX 列表接口。一次探测约 1.7 万候选, 串行批量(~80/批)约 1 分钟, 结果写快照缓存。
const TENCENT_PREFIX_SEGMENTS = {
  sh: ['600', '601', '603', '605', '688', '689'], // 沪市主板 + 科创板
  sz: ['000', '001', '002', '003', '300', '301'], // 深市主板 + 创业板
  bj: ['83', '87', '88', '89', '92'],             // 北交所 / 新三板 (排除老三板43)
};
function genTencentCandidates() {
  const out = [];
  for (const [m, prefs] of Object.entries(TENCENT_PREFIX_SEGMENTS)) {
    for (const p of prefs) {
      for (let i = 0; i < 1000; i++) out.push(m + p + String(i).padStart(3, '0'));
    }
  }
  return out;
}
const _TENCENT_BATCH = 80;
async function fetchFromTencent() {
  const cands = genTencentCandidates();
  const found = new Map();
  for (let i = 0; i < cands.length; i += _TENCENT_BATCH) {
    const batch = cands.slice(i, i + _TENCENT_BATCH);
    try {
      const quotes = await getQuotes(batch);
      for (const q of quotes) {
        if (q && q.code && q.name && /^(sh|sz|bj)\d{6}$/.test(q.code)) {
          found.set(q.code, { code: q.code, name: q.name, market: q.code.slice(0, 2) });
        }
      }
    } catch (_) { /* 单批失败忽略, 继续探测其余候选 */ }
    await new Promise((r) => setTimeout(r, 15)); // 轻量节流, 避免触发腾讯限流
  }
  return Array.from(found.values());
}

// ---- 本地快照 CSV 读写(code,name,market) ----
function readSnapshot() {
  if (!fs.existsSync(SNAPSHOT_PATH)) return null;
  const txt = fs.readFileSync(SNAPSHOT_PATH, 'utf8').trim();
  const lines = txt.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  if (lines[0].startsWith('code,')) lines.shift(); // 跳过表头
  return lines.map((ln) => {
    const [code, name, market] = ln.split(',');
    return { code, name: (name || code).replace(/^"|"$/g, ''), market: market || (code ? code.slice(0, 2) : '') };
  }).filter((s) => /^(sh|sz|bj)\d{6}$/.test(s.code));
}
function writeSnapshot(stocks) {
  const dir = path.dirname(SNAPSHOT_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const body = ['code,name,market', ...stocks.map((s) => `${s.code},${s.name},${s.market}`)].join('\n');
  fs.writeFileSync(SNAPSHOT_PATH, body, 'utf8');
}
function writeCache(obj) {
  try {
    const dir = path.dirname(CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(obj), 'utf8');
  } catch (_) { /* 缓存写失败不影响返回 */ }
}

/**
 * 获取 A股全市场列表
 * @param {{force?:boolean, source?:string}} opt
 *   force=true   强制重新从当前源抓取(并刷新本地快照), 忽略模式。
 *   source       显式指定 'tdx' | 'eastmoney' | 'local'(覆盖配置)。
 * @returns {Promise<{updated:string,count:number,stocks:Array<{code,name,market}>,source?:string,error?:string}>}
 */
// 内存缓存: 默认加载(非 force、非显式 source)命中即秒回, 避免每次打开行情中心都重跑 getUniverse
// (含重新解析快照 CSV / 试探各数据源)。仅成功结果入缓存; 显式刷新(force/source)会重算并更新缓存。
let _universeCache = null;
// 证券类型分类: 依据上交所/深交所/北交所官方代码段规则(权威、离线、零成本)。
// 首位数字 + 市场 = 证券类别; 6/0/3/8/4 开头 = 股票, 其余(1/2=债券与回购, 5=基金/ETF, 0=指数国债, 9=B股)非股票。
function classify(code) {
  const m = String(code || '').match(/^(sh|sz|bj)(\d{6})$/);
  if (!m) return { type: '未知', short: '?', isStock: false };
  const mk = m[1], d = m[2], f = d[0];
  let type, short, isStock = true;
  if (mk === 'sh') {
    if (f === '6') { type = 'A股'; }
    else if (f === '9') { type = 'B股'; short = 'B'; isStock = false; }
    else if (f === '0') { type = '指数/国债'; short = '指'; isStock = false; }
    else if (f === '1') { type = '债券'; short = '债'; isStock = false; }
    else if (f === '2') { type = '债券回购'; short = '债'; isStock = false; }
    else if (f === '5') { type = '基金/ETF'; short = '基'; isStock = false; }
    else if (f === '3') { type = '优先股/国债期货'; short = '其他'; isStock = false; }
    else { type = '其他'; short = '其他'; isStock = false; }
  } else if (mk === 'sz') {
    if (f === '0') { type = 'A股(主板/中小板)'; }
    else if (f === '3') { type = '创业板'; }
    else if (f === '1') { type = '债券'; short = '债'; isStock = false; }
    else if (f === '2') { type = 'B股/回购'; short = 'B'; isStock = false; }
    else if (f === '5') { type = '基金/ETF'; short = '基'; isStock = false; }
    else { type = '其他'; short = '其他'; isStock = false; }
  } else { // bj
    if (f === '8' || f === '4') { type = '北交所股票'; }
    else { type = '北交所其他'; short = '其他'; isStock = false; }
  }
  if (!short) short = isStock ? '股' : '其他';
  return { type, short, isStock };
}

// 退市判定: 名称含"退"字(离线) ∪ 腾讯 qt 字段[40]='D' 探针(覆盖名称不含退的退市股如 600001 邯郸钢铁)。
// 动态计算(探针结果落库 stock_delist_probe), 行情中心据此显著标识退市股票、回补据此跳过退市股票。
function decorate(s, probeSet, industryMap) {
  const t = classify(s.code);
  return {
    code: s.code, name: s.name, market: s.market,
    delisted: /退/.test(s.name || '') || !!(probeSet && probeSet.has(s.code)),
    securityType: t.type, securityShort: t.short, isStock: t.isStock,
    industry: (industryMap && industryMap[s.code]) || '',
  };
}
function decorateAll(stocks) {
  const probeSet = gstore.getDelistedProbeSet();
  const industryMap = getIndustryMap();
  return (stocks || []).map((s) => decorate(s, probeSet, industryMap));
}
async function getUniverse({ force, source } = {}) {
  if (!force && !source && _universeCache) return _universeCache;
  // 快速路径: 全市场列表已落在 global.db.stock 表(列表即数据库), 直接返回,
  // 避免每次打开行情中心都重跑 getUniverse 的网络试探 / CSV 解析(默认加载走此路, 毫秒级)。
  if (!force && !source) {
    const fromDb = gstore.getStocks();
    if (fromDb && fromDb.length) {
      const result = {
        updated: getMeta('universe_updated') || new Date().toISOString(),
        count: fromDb.length,
        stocks: decorateAll(fromDb),
        source: getMeta('universe_source') || 'db',
      };
      _universeCache = result;
      return result;
    }
  }
  const mode = source || readConfig().universe || 'tdx';
  let result;
  if (mode === 'tdx') result = await getFromTdx(!!force);
  else if (mode === 'tencent') result = await getFromTencent(!!force);
  else if (mode === 'local') result = getFromLocal();
  else result = await getFromEastmoney(!!force); // 'eastmoney' 默认
  if (result && result.stocks && result.stocks.length) {
    setMeta('universe_source', result.source || mode);
    setMeta('universe_updated', result.updated || new Date().toISOString());
  }
  if (result && result.stocks && result.stocks.length) result.stocks = decorateAll(result.stocks);
  if (!force && !source && result && result.stocks && result.stocks.length) _universeCache = result;
  return result;
}

// 通达信网关枚举(全市场); 空/失败时自动降级: 先回退本地快照(秒回) → 再试腾讯探测(一次性生成)
async function getFromTdx(force) {
  const snap = readSnapshot();
  let stocks = []; let err = null;
  try { stocks = await fetchFromTdx(); if (stocks.length) { writeSnapshot(stocks); gstore.upsertStocks(stocks); } }
  catch (e) { err = '无法从 TDX 网关获取股票列表：' + e.message; }
  if (stocks.length) {
    const out = { updated: new Date().toISOString(), count: stocks.length, stocks, source: 'tdx' };
    writeCache(out);
    return out;
  }
  // ① 非强制刷新且有快照 → 秒回本地快照(默认加载走此路, 立即展示列表)
  if (!force && snap && snap.length) {
    return { updated: new Date().toISOString(), count: snap.length, stocks: snap,
      source: 'local', error: (err || 'TDX 返回空') + '；已回退本地快照。' };
  }
  // ② 强制刷新 或 无快照 → 自动改用腾讯报价探测枚举(重新生成, 不依赖东财/TDX列表)
  try {
    const ts = await fetchFromTencent();
    if (ts.length) {
      writeSnapshot(ts);
      gstore.upsertStocks(ts);
      const out = { updated: new Date().toISOString(), count: ts.length, stocks: ts, source: 'tencent',
        error: (err || 'TDX 返回空') + '；已自动改用「腾讯报价探测」枚举全市场。' };
      writeCache(out);
      return out;
    }
  } catch (e) { err = (err ? err + '；' : '') + '腾讯探测失败：' + e.message; }
  // ③ 腾讯失败 → 再回退快照(若有)
  if (snap && snap.length) {
    return { updated: new Date().toISOString(), count: snap.length, stocks: snap,
      source: 'local', error: (err || '腾讯返回空') + '；已回退本地快照。' };
  }
  // ④ 连腾讯探测/快照都没数据
  const out = { updated: new Date().toISOString(), count: 0, stocks: [],
    error: (err || '空列表') + '（腾讯探测未返回数据且本地无快照，请确认可访问 qt.gtimg.cn；或在东财可用时切换）。' };
  writeCache(out);
  return out;
}

// 腾讯报价探测枚举(全市场); 失败回退本地快照
async function getFromTencent(force) {
  let stocks = []; let err = null;
  try { stocks = await fetchFromTencent(); if (stocks.length) { writeSnapshot(stocks); gstore.upsertStocks(stocks); } }
  catch (e) { err = '腾讯探测失败：' + e.message; }
  if (stocks.length) {
    const out = { updated: new Date().toISOString(), count: stocks.length, stocks, source: 'tencent' };
    writeCache(out);
    return out;
  }
  const snap = readSnapshot();
  if (snap && snap.length) {
    return { updated: new Date().toISOString(), count: snap.length, stocks: snap,
      source: 'local', error: (err || '腾讯返回空') + '；已回退本地快照。' };
  }
  const out = { updated: new Date().toISOString(), count: 0, stocks: [],
    error: (err || '空列表') + '（腾讯探测未返回数据，请确认可访问 qt.gtimg.cn；或在东财可用时切换）。' };
  writeCache(out);
  return out;
}

// 东财 clist 枚举(全市场), 失败回退本地快照
async function getFromEastmoney(force) {
  let stocks = []; let err = null;
  try { stocks = await fetchFromEm(); if (stocks.length) { writeSnapshot(stocks); gstore.upsertStocks(stocks); } }
  catch (e) { err = '无法从东财获取股票列表：' + e.message; }
  if (stocks.length) {
    const out = { updated: new Date().toISOString(), count: stocks.length, stocks, source: 'eastmoney' };
    writeCache(out);
    return out;
  }
  const snap = readSnapshot();
  if (snap && snap.length) {
    return { updated: new Date().toISOString(), count: snap.length, stocks: snap,
      source: 'local', error: (err || '东财返回空') + '；已回退本地快照。' };
  }
  const out = { updated: new Date().toISOString(), count: 0, stocks: [],
    error: (err || '空列表') + '（请确认本机可访问东财后点「刷新列表」）。' };
  writeCache(out);
  return out;
}

// 本地快照
function getFromLocal() {
  const snap = readSnapshot();
  if (snap && snap.length) {
    return { updated: new Date().toISOString(), count: snap.length, stocks: snap, source: 'local' };
  }
  return { updated: new Date().toISOString(), count: 0, stocks: [],
    error: '本地快照缺失：请在「东财节点」或「TDX 网关」可用时切回对应模式点「刷新列表」生成快照，或把「股票池来源」切回东财/TDX。' };
}

/**
 * 仅探测(不落盘): 各源(东财/本地快照/TDX 网关)可达性与条数。
 * 供「数据来源配置」页的「测试全部接口」使用。
 */
async function checkUniverse() {
  const cfg = readConfig();
  const out = { source: cfg.universe, emOk: false, emError: null, localCount: 0, localPath: SNAPSHOT_PATH,
    tdxOk: false, tdxError: null, tdxCount: 0, tdxEndpoint: tdxEndpoint() || null,
    tencentOk: false, tencentError: null, tencentCount: 0 };
  // 东财
  try { const s = await fetchFromEm(); out.emOk = Array.isArray(s) && s.length > 0; }
  catch (e) { out.emError = e.message; }
  // 本地快照
  const snap = readSnapshot();
  out.localCount = snap ? snap.length : 0;
  // TDX 网关
  const ep = tdxEndpoint();
  if (!ep) out.tdxError = 'TDX_ENDPOINT 未配置(网关未启动)';
  else {
    try {
      await rate.acquire();
      const headers = { 'User-Agent': 'quant-web/1.0' };
      const tok = tdxToken();
      if (tok) headers.Authorization = 'Bearer ' + tok;
      const r = await fetch(ep + '/stocks?limit=5', { headers });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      out.tdxOk = !!(j && j.ok && Array.isArray(j.stocks));
      out.tdxCount = j ? (j.count || 0) : 0;
      out.tdxError = (j && !j.ok) ? (j.reason || '网关返回失败') : null;
    } catch (e) { out.tdxError = e.message; }
  }
  // 腾讯探测枚举(用已知有效 A股代码验证行情接口可用)
  try {
    const tq = await getQuotes(['sh600000', 'sz000001', 'sh688981', 'bj830799']);
    out.tencentOk = Array.isArray(tq) && tq.length > 0;
    out.tencentCount = tq ? tq.length : 0;
  } catch (e) { out.tencentError = e.message; }
  return out;
}

/**
 * 后台退市探针: 批量 getQuotes 全市场列表, 命中腾讯 qt 字段[40]='D'(退市/停牌) 的落库 stock_delist_probe。
 * 覆盖"名称不含退"的退市股(如 600001 邯郸钢铁、600002 齐鲁石化), 与名称含退的离线判定取并集。
 * 启动时由 index.js 在后台触发(非阻塞); 完成后清除列表缓存, 使下次请求用新探针结果重新装饰。
 * 已跑过(delist_probe_done)则跳过; 失败(网络)不置 done, 下次启动重试。
 */
async function probeDelisted() {
  if (getMeta('delist_probe_done')) return { skipped: true };
  setMeta('delist_probe_at', new Date().toISOString());
  const stocks = gstore.getStocks();
  if (!stocks.length) { setMeta('delist_probe_done', new Date().toISOString()); return { total: 0, delisted: 0 }; }
  const BATCH = 80;
  let found = 0;
  for (let i = 0; i < stocks.length; i += BATCH) {
    const batch = stocks.slice(i, i + BATCH);
    try {
      const quotes = await getQuotes(batch.map((s) => s.code));
      for (const q of quotes) {
        if (q && q.status === 'D') { gstore.saveDelistedProbe(q.code, 'qt_status_D'); found++; }
      }
    } catch (_) { /* 单批失败忽略, 继续探测其余 */ }
    await new Promise((r) => setImmediate(r)); // 让出事件循环, 不阻塞 HTTP 服务
  }
  setMeta('delist_probe_done', new Date().toISOString());
  _universeCache = null; // 探针完成, 下次列表请求用新结果重新装饰
  return { total: stocks.length, delisted: found };
}

module.exports = { getUniverse, checkUniverse, fetchFromTdx, probeDelisted, CACHE_PATH, SNAPSHOT_PATH, readSnapshot, writeSnapshot };
