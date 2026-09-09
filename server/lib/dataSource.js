'use strict';
/**
 * 数据来源配置 (server/lib/dataSource.js)
 * ------------------------------------------------------------------
 * 以「渠道(channel)」为单一事实来源, 建立 CHANNELS 注册表, 枚举每个渠道能提供的
 * 全部数据能力(实时报价/日K/5分钟K/当日分时/历史分时回补)及其经实测确认的真实上限。
 * CATALOG / LIVE_INTRADAY / DEFAULTS 均由 CHANNELS 派生, 确保"渠道能力 ↔ 配置可选项"
 * 始终一致, 不会出现"某渠道其实有能力却没连成选项"或"选项指向渠道不具备的能力"。
 *
 * capability.status 取值:
 *   'fixed'      → 该数据类型唯一/固定由该渠道提供(不可切换, 如实时报价=腾讯)
 *   'switchable' → 该渠道确实可服务此数据类型, 且已接通为可切换选项
 *   'capable'    → 该渠道技术上可服务此数据类型, 但 provider 尚未接入切换(待扩展)
 *   'no'         → 该渠道不提供此数据类型
 *
 * 实测结论(2026-07, 见 scripts/test_providers.js 与本次新浪日K实测):
 *   - 腾讯 日K:  请求≤800 精确返回; 请求>1000 会回退到仅 641 根 → 安全上限≈800(≈3.2年)
 *   - 腾讯 5分钟: 请求≤480 精确返回; 请求>480 回退到 320 根 → 安全上限=480(≈一周多)
 *   - 新浪 5分钟: datalen≤5001 根 ≈105 交易日 ≈5 个月(免费最深)
 *   - 新浪 日K:   scale=240, datalen≤5001 根 ≈20 年(免费最深日K, 无成交额)
 *   - 东财 日K:   beg/end 自由回溯多年(lmt≤3000≈12年), 含 amount/turnover/amplitude/pct
 *   - 东财 5分钟: klt=5, 单次≤5001根(≈5个月), 含 amount; 已接入为 min5 可选项
 *   - 东财 分时:   trends2 ndays≈5 交易日(免费上限)
 *   - TDX 日K:    经网关 category=4 取日线, 已接入为 day 可选项(需启动网关)
 *   - TDX 5分钟:  经网关 category=0 取5分钟, 已接入为 min5 可选项(需启动网关)
 *   - TDX 分时:   1分钟线, 经 pytdx 网关分页, 上限≈167 交易日(60页×680行÷240行/日), 需自建网关
 */
const { readJson, writeJson } = require('./store');
// 引入 TDX provider 以取其反推的"可回补交易日上限"(TDX_MAX_DAYS), 作为 web 上限单一事实来源
// (tdx_intraday 仅在 require 时定义常量/函数, 无副作用, 不会触发网络)
const tdx = require('../providers/tdx_intraday');

// 数据类型轴(展示用元数据); intradayLive 固定腾讯, 单独展示不进可切换 CATALOG
const TYPE_META = {
  quote: { label: '实时报价', desc: '看盘/自选/持仓/预警的实时价格来源', switchable: false },
  day: { label: '日K线', desc: '实时看盘的日K图与日线指标来源', switchable: true },
  min5: { label: '5分钟K线', desc: '5分钟K图与分钟指标的历史来源(叠加腾讯当日实时刷新)', switchable: true },
  intradayBackfill: { label: '历史分时回补', desc: '回补过往交易日的分时(1分钟级)数据落盘，用于分时复盘', switchable: true },
  universe: { label: '股票池来源', desc: '行情中心收录的全市场股票列表来源（通达信网关枚举 / 腾讯探测枚举 / 东财 clist / 本地快照）', switchable: true },
  backtestDay: { label: '回测日K来源', desc: '短线选股(S系)回测的日K数据源；东财含换手/振幅，腾讯/新浪需降级', switchable: true },
  intradayLive: { label: '当日分时(实时)', desc: '固定腾讯 minute/query，仅当日', switchable: false },
};

// 默认选源(仅对 switchable 类型生效; fixed 类型由 CHANNELS 固定决定)
const DEFAULTS = { quote: 'tencent', day: 'tdx', min5: 'tdx', intradayBackfill: 'tdx', universe: 'tdx', backtestDay: 'eastmoney', emNode: 'auto', tdxAutoStart: true };

// ============ 渠道 × 能力 注册表(单一事实来源) ============
const CHANNELS = {
  tencent: {
    id: 'tencent', name: '腾讯自选股',
    caps: {
      quote: { status: 'fixed', endpoint: 'qt.gtimg.cn',
        range: '实时快照(可3秒刷新)', anchor: '当前时刻', unitCap: '',
        fields: 'name,price,open,high,low,volume,amount,turnover,pe,总/流通市值等16项',
        note: '唯一实时报价源，WebSocket 每3秒推送。' },
      day: { status: 'switchable', endpoint: 'web.ifzq.gtimg.cn',
        range: '安全 ≤800 根(≈3.2年)', anchor: '锚定今天倒推', unitCap: '请求>1000 会回退到641根',
        fields: 'date, OHLC, volume(前复权)',
        note: '看盘首选，响应快；仅 OHLCV，无成交额/换手/振幅。' },
      min5: { status: 'switchable', endpoint: 'proxy.finance.qq.com',
        range: '安全 ≤480 根(≈一周多)', anchor: '锚定今天', unitCap: '请求>480 会回退到320根',
        fields: 'date, OHLC, volume, amount',
        note: '历史浅，约一周；含成交额。' },
      intradayLive: { status: 'fixed', endpoint: 'web.ifzq.gtimg.cn',
        range: '当日约240点', anchor: '当日', unitCap: '',
        fields: 't, price, avg, volume, cumVolume',
        note: '固定腾讯 minute/query，仅当日，交易时段每3分钟自动落盘。' },
      intradayBackfill: { status: 'no', endpoint: '', range: '不支持', anchor: '', unitCap: '',
        fields: '', note: '腾讯无历史分时回补接口。' },
    },
  },
  sina: {
    id: 'sina', name: '新浪财经',
    caps: {
      quote: { status: 'no', endpoint: '', range: '不支持', anchor: '', unitCap: '', fields: '', note: '新浪不提供实时报价快照。' },
      day: { status: 'switchable', endpoint: 'money.finance.sina.com.cn',
        range: 'datalen ≤5001 根(≈20年)', anchor: '锚定今天倒推', unitCap: '单次上限 5001 根',
        fields: 'date, OHLC, volume(无成交额)',
        note: '历史极深(≈20年)；无成交额/换手/振幅。已实测 5001 根可用。' },
      min5: { status: 'switchable', endpoint: 'money.finance.sina.com.cn',
        range: 'datalen ≤5001 根(≈105交易日≈5个月)', anchor: '锚定今天倒推', unitCap: '单次上限 5001 根',
        fields: 'date, OHLC, volume(无成交额)',
        note: '免费源历史最深，覆盖一个月以上视图；无成交额字段。' },
      intradayLive: { status: 'no', endpoint: '', range: '不支持', anchor: '', unitCap: '', fields: '', note: '新浪无当日分时快照接口。' },
      intradayBackfill: { status: 'no', endpoint: '', range: '不支持', anchor: '', unitCap: '', fields: '', note: '新浪分时仅 getKLineData 历史K，无分时回补。' },
    },
  },
  eastmoney: {
    id: 'eastmoney', name: '东财',
    caps: {
      quote: { status: 'no', endpoint: 'push2.eastmoney.com', range: '未接入(可经 push2 实时, 待扩展)', anchor: '', unitCap: '', fields: '', note: '当前 provider 未实现实时报价；东财 push2 可补。' },
      day: { status: 'switchable', endpoint: 'push2his.eastmoney.com',
        range: 'beg/end 自由回溯多年(lmt ≤3000 ≈12年)', anchor: '可指定任意历史区间', unitCap: 'lmt 上限约3000根',
        fields: 'date, OHLC, volume, amount, turnover, amplitude, pct',
        note: '回测/短线选股(S系规则)底座；含换手率、振幅、成交额等硬依赖字段。' },
      min5: { status: 'switchable', endpoint: 'push2his.eastmoney.com',
        range: 'klt=5 回溯多年(单次≤5001根≈5个月)', anchor: '可指定任意历史区间', unitCap: 'lmt 上限约5001根',
        fields: 'date, OHLC, volume, amount',
        note: '已接入：klt=5 多分钟线，比新浪更深、含成交额；依赖 push2his（部分受限网络不可用，本机正常）。' },
      intradayLive: { status: 'no', endpoint: '', range: '不支持', anchor: '', unitCap: '', fields: '', note: '东财分时仅 trends2 历史接口，无当日实时分时快照。' },
      intradayBackfill: { status: 'switchable', endpoint: 'push2his.eastmoney.com',
        range: 'ndays ≤5 交易日(每日约240点)', anchor: '最近 N 个交易日', unitCap: '免费上限约5交易日',
        fields: 't, price, avg, volume, cumVolume',
        note: '免费、无需部署；历史上限约5个交易日。' },
    },
  },
  tdx: {
    id: 'tdx', name: '通达信网关(pytdx)',
    caps: {
      quote: { status: 'no', endpoint: '', range: '不支持', anchor: '', unitCap: '', fields: '', note: 'TDX 网关不提供实时报价。' },
      day: { status: 'switchable', endpoint: 'TDX_ENDPOINT(自建网关)',
        range: '经 pytdx 日线(category=4, 多年)', anchor: '最近 N 个交易日', unitCap: '网关单次≤800根/页, 分页封顶60页',
        fields: 'date, OHLC, volume',
        note: '已接入：网关扩展 category=4 后提供日K；需在「🧩 TDX 网关」页启动网关，未部署时自动降级腾讯。' },
      min5: { status: 'switchable', endpoint: 'TDX_ENDPOINT(自建网关)',
        range: '经 pytdx 5分钟(category=0, 多年)', anchor: '最近 N 个交易日', unitCap: '网关单次≤800根/页, 分页封顶60页',
        fields: 'date, OHLC, volume',
        note: '已接入：网关扩展 category=0 后提供5分钟；需启动网关，未部署时自动降级新浪。' },
      intradayLive: { status: 'no', endpoint: '', range: '不支持', anchor: '', unitCap: '', fields: '', note: 'TDX 网关不提供当日分时快照。' },
      intradayBackfill: { status: 'switchable', endpoint: 'TDX_ENDPOINT(自建网关)',
        range: '1分钟线，上限约167交易日(60页封顶)', anchor: '最近 N 个交易日', unitCap: '单只≤60页分页',
        fields: 't, price, avg, volume, cumVolume',
        note: '历史更深，但需在「TDX 网关」页启动 pytdx 网关；未部署时自动降级。' },
    },
  },
};

// ---- 由 CHANNELS 派生 CATALOG(可切换数据类型 → 可选渠道) ----
const CATALOG = {};
for (const [key, meta] of Object.entries(TYPE_META)) {
  if (key === 'intradayLive') continue; // 固定源, 单独作为 LIVE_INTRADAY 展示
  const options = [];
  for (const ch of Object.values(CHANNELS)) {
    const cap = ch.caps[key];
    if (!cap) continue;
    if (cap.status === 'switchable') {
      // 历史分时回补按源设定"可回补交易日上限": 东财免费≈5日, TDX 不封顶(0=无上限, 实际深度由服务器数据下限决定)
      const maxDays = key === 'intradayBackfill'
        ? (ch.id === 'tdx' ? 0 : (ch.id === 'eastmoney' ? 5 : 60))
        : undefined;
      options.push({ id: ch.id, name: ch.name, endpoint: cap.endpoint, status: 'switchable',
        range: cap.range, anchor: cap.anchor, unitCap: cap.unitCap, fields: cap.fields, note: cap.note,
        maxDays });
    } else if (meta.switchable === false && cap.status === 'fixed') {
      options.push({ id: ch.id, name: ch.name, endpoint: cap.endpoint, status: 'fixed',
        range: cap.range, anchor: cap.anchor, unitCap: cap.unitCap, fields: cap.fields, note: cap.note });
    }
  }
  CATALOG[key] = { ...meta, options, default: DEFAULTS[key] };
}

// ---- 额外「元来源」配置(非单一渠道能力, 手工构造) ----
// 股票池来源: 通达信网关枚举(默认) / 东财 clist / 本地快照
CATALOG.universe = {
  ...TYPE_META.universe,
  default: DEFAULTS.universe,
  options: [
    { id: 'tdx', name: '通达信网关', status: 'switchable',
      endpoint: 'TDX_ENDPOINT(自建网关)/stocks', range: '全市场沪深京A股(经 pytdx 枚举)', anchor: '实时枚举', unitCap: '',
      fields: 'code,name,market', note: '经 TDX 网关 get_security_list 枚举全市场；需在「🧩 TDX 网关」页启动网关(默认随系统启动)。⚠️ 实测 TDX 公共行情节点普遍 get_security_list 返回空(仅券商自建服务器提供), 此时会自动降级到「腾讯探测枚举」。成功抓取写本地快照。' },
    { id: 'tencent', name: '腾讯探测枚举', status: 'switchable',
      endpoint: 'qt.gtimg.cn/q=', range: '全市场沪深京A股(批量报价反推)', anchor: '实时枚举', unitCap: '约1.7万候选×批量探测(一次性~1分钟)',
      fields: 'code,name,market', note: 'TDX 公共节点列表空 / 东财被拦截时的兜底：按 A股代码段生成候选, 批量调腾讯 qt.gtimg.cn 报价接口反推有效股票。行情接口在本环境确认可用, 完全不依赖被墙的东财与被限的 TDX 列表。结果写本地快照。' },
    { id: 'eastmoney', name: '东财 clist', status: 'switchable',
      endpoint: 'push2.eastmoney.com/api/qt/clist/get', range: '全市场沪深京A股(实时枚举)', anchor: '实时', unitCap: '',
      fields: 'code,name,market', note: '本环境 push2 主机被网络拦截，可在「东财节点」填入可用镜像，或切换为本地快照/腾讯探测。' },
    { id: 'local', name: '本地快照', status: 'switchable',
      endpoint: 'data/stocks_universe_local.csv', range: '最近一次成功抓取的快照', anchor: '快照', unitCap: '需先有快照',
      fields: 'code,name,market', note: '读取本地快照 CSV，各源不可用时仍能展示全市场；在源可用时点「刷新列表」即生成/更新快照。' },
  ],
};
// 回测日K来源: 东财(含换手/振幅) 或 腾讯/新浪(降级, 无换手)
CATALOG.backtestDay = {
  ...TYPE_META.backtestDay,
  default: DEFAULTS.backtestDay,
  options: [
    { id: 'eastmoney', name: '东财日K', status: 'switchable',
      endpoint: 'push2his.eastmoney.com', range: '近3年, 含换手/振幅/成交额', anchor: '自由回溯', unitCap: '',
      fields: 'date,OHLC,volume,amount,turnover,amplitude,pct', note: 'S系规则换手/振幅硬依赖；本环境 push2his 被网络拦截，失败时回退腾讯/新浪。' },
    { id: 'tencent', name: '腾讯日K', status: 'switchable',
      endpoint: 'web.ifzq.gtimg.cn', range: '≤800根≈3.2年', anchor: '锚定今天', unitCap: '',
      fields: 'date,OHLC,volume', note: '无换手率；S系「换手过滤」自动放宽(缺失视为通过)。' },
    { id: 'sina', name: '新浪日K', status: 'switchable',
      endpoint: 'money.finance.sina.com.cn', range: '≈20年最深', anchor: '锚定今天', unitCap: '',
      fields: 'date,OHLC,volume', note: '无换手率；S系「换手过滤」自动放宽(缺失视为通过)。' },
  ],
};

// 当日分时(实时) 固定腾讯, 由 CHANNELS 派生
const LIVE_INTRADAY = (() => {
  const c = CHANNELS.tencent.caps.intradayLive;
  return { label: TYPE_META.intradayLive.label, source: 'tencent', endpoint: c.endpoint,
    range: c.range, fields: c.fields, note: c.note };
})();

/** 读取配置(缺失/非法项回落到默认) */
function readConfig() {
  const stored = readJson('datasource-config.json', null) || {};
  const out = {};
  for (const k of Object.keys(CATALOG)) {
    const val = stored[k];
    const valid = CATALOG[k].options.some((o) => o.id === val);
    out[k] = valid ? val : CATALOG[k].default;
  }
  // 东财节点(host 覆盖): 'auto' 或自定义主机(如可用镜像); 任意非空字符串均保留
  out.emNode = (stored && typeof stored.emNode === 'string' && stored.emNode.trim()) ? stored.emNode.trim() : 'auto';
  // 通达信网关随系统启动(布尔); 未显式设置时回落默认 true(满足"配合系统启动一起启动")
  out.tdxAutoStart = (stored && typeof stored.tdxAutoStart === 'boolean') ? stored.tdxAutoStart : (DEFAULTS.tdxAutoStart ?? true);
  return out;
}

/** 保存配置(仅接受合法 switchable 选项, 非法忽略) */
function saveConfig(o) {
  const next = readConfig();
  for (const k of Object.keys(CATALOG)) {
    if (!CATALOG[k].switchable) continue;
    if (o && o[k] && CATALOG[k].options.some((x) => x.id === o[k])) next[k] = o[k];
  }
  if (o && typeof o.emNode === 'string' && o.emNode.trim()) next.emNode = o.emNode.trim();
  if (o && typeof o.tdxAutoStart === 'boolean') next.tdxAutoStart = o.tdxAutoStart;
  writeJson('datasource-config.json', next);
  return next;
}

/**
 * 东财节点(host)解析: 返回用户配置的自定义主机(去除协议/路径, 仅留 host),
 * 或 null(调用方按用途选默认 push2 / push2his)。emNode='auto' 或空 → null。
 */
function emHost() {
  const n = readConfig().emNode;
  if (n && n !== 'auto') return String(n).replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\?.*$/, '');
  return null;
}

module.exports = { CHANNELS, TYPE_META, CATALOG, LIVE_INTRADAY, DEFAULTS, readConfig, saveConfig, emHost };
