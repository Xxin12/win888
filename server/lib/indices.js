'use strict';
/**
 * 大盘各类指数清单（行情中心「大盘指数」分类的数据底座）
 *
 * 与 A股 stockUniverse 完全解耦: 指数不进入全局股票池(global.db.stock),
 * 因此不会污染 dailySync / 看盘页 / 自选 / 持仓等任何 A股 相关逻辑 —— 严格限定在「行情中心」边界内。
 *
 * 代码均为交易所官方指数代码, 已实测(腾讯 getMinute / 东财 getIntradayRange)可真实取到分时行情。
 * 5分钟 / 日线回补走 loadBars(内部 eastmoney_day / sina), 对指数代码同样生效。
 */
const gstore = require('./globalStore');

// 大盘各类指数（综合 / 规模 / 板块 / 策略）
const MAJOR_INDICES = [
  // —— 综合指数 ——
  { code: 'sh000001', name: '上证指数', market: 'sh', category: '综合' },
  { code: 'sz399001', name: '深证成指', market: 'sz', category: '综合' },
  // —— 规模指数 ——
  { code: 'sh000300', name: '沪深300', market: 'sh', category: '规模' },
  { code: 'sh000016', name: '上证50', market: 'sh', category: '规模' },
  { code: 'sh000905', name: '中证500', market: 'sh', category: '规模' },
  { code: 'sh000852', name: '中证1000', market: 'sh', category: '规模' },
  { code: 'sh000903', name: '中证100', market: 'sh', category: '规模' },
  { code: 'sh000010', name: '上证180', market: 'sh', category: '规模' },
  { code: 'sz399330', name: '深证100', market: 'sz', category: '规模' },
  { code: 'sz399005', name: '中小100', market: 'sz', category: '规模' },
  { code: 'sz399303', name: '国证2000', market: 'sz', category: '规模' },
  // —— 板块指数 ——
  { code: 'sz399006', name: '创业板指', market: 'sz', category: '板块' },
  { code: 'sh000688', name: '科创50', market: 'sh', category: '板块' },
  { code: 'bj899050', name: '北证50', market: 'bj', category: '板块' },
  // —— 策略指数 ——
  { code: 'sh000015', name: '红利指数', market: 'sh', category: '策略' },
];

const INDEX_CODES = MAJOR_INDICES.map((x) => x.code);

/** 判断某代码是否为「大盘指数」(本系统维护的 15 只)。用于回补/行情加载时避开对指数失效或返回脏数据的数据源(如 TDX 网关对指数代码返回损坏序列)。 */
function isIndexCode(code) {
  return INDEX_CODES.indexOf(String(code)) >= 0;
}

/**
 * 返回带「本地数据覆盖」装饰的大盘指数列表(供行情中心表格展示 + 回补)。
 * 覆盖信息取自 global.db.stock_coverage(回补落盘时由 marketStore.recordCoverage 写入),
 * 未回补的指数自动回落为 {has5min:0,hasDay:0,intradayDates:0}。
 * 指数恒为 isStock:false / delisted:false / industry:'' —— 与 A股 列表字段对齐, 直接复用前端表格与回补按钮。
 * @returns {Array<{code,name,market,category,securityType,securityShort,isStock,delisted,industry,has5min,hasDay,intradayDates}>}
 */
function getIndices() {
  let covMap = new Map();
  try { covMap = gstore.getCoverageMap(INDEX_CODES); } catch (_) { /* ignore */ }
  return MAJOR_INDICES.map((x) => {
    const c = covMap.get(x.code) || {};
    return {
      code: x.code,
      name: x.name,
      market: x.market,
      category: x.category,
      securityType: '指数',
      securityShort: '指',
      isStock: false,
      delisted: false,
      industry: '',
      has5min: !!c.has5min,
      hasDay: !!c.hasDay,
      intradayDates: c.intradayDates || 0,
    };
  });
}

module.exports = { MAJOR_INDICES, INDEX_CODES, getIndices, isIndexCode };
