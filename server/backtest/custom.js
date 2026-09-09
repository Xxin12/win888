'use strict';
/**
 * 自定义策略沙箱执行
 * ----------------------------------------------------------------
 * 用户在前端编写的策略代码, 在此以受限沙箱(vm)执行, 避免直接 eval 污染主进程。
 * 代码约定(页面已给出模板):
 *   function strategy(days, ctx) { ... return trades; }
 *     days: [{ date:'YYYY-MM-DD', bars:[{ t:'HH:MM', datetime, open, high, low, close, volume, amount }] }]
 *     ctx:  { qty:Number }
 *     return: [{ date, buy_p, sell_p }]   // 每笔买=卖=qty 股, 不留隔夜
 * 返回: 规范化后的交易数组 [{ date, buy_p, sell_p }]
 */
const vm = require('vm');

const TIMEOUT_MS = 2000;

function runCustomStrategy(code, days, ctx) {
  if (!code || !code.trim()) throw new Error('自定义策略代码为空');

  // 受限沙箱: 仅暴露常用安全全局, 禁止访问 require/process/fs 等
  const sandbox = {
    Math, Date, JSON, console,
    isNaN, isFinite, parseFloat, parseInt,
    Array, Object, Number, String, Boolean, Map, Set,
  };
  vm.createContext(sandbox);

  // 用 IIFE 包裹: 既支持 `function strategy(){}` 声明, 也能捕获返回值; 屏蔽顶层 return
  let factory;
  try {
    factory = vm.runInContext(
      `(function(){ ${code}\n; return (typeof strategy === 'function') ? strategy : null; })()`,
      sandbox,
      { timeout: TIMEOUT_MS }
    );
  } catch (e) {
    if (e instanceof RangeError && /timeout|exceeded/i.test(e.message)) {
      throw new Error(`策略执行超时(>${TIMEOUT_MS}ms, 可能存在死循环)`);
    }
    throw new Error('策略编译失败: ' + e.message);
  }

  if (typeof factory !== 'function') {
    throw new Error('自定义策略须包含 `function strategy(days, ctx) { ... }` 定义');
  }

  let raw;
  try {
    raw = factory(days, ctx);
  } catch (e) {
    throw new Error('策略运行异常: ' + e.message);
  }
  if (!Array.isArray(raw)) throw new Error('strategy 必须返回交易数组 []');

  return raw.map((t, i) => {
    const date = String((t && t.date) || '');
    const bp = Number(t && t.buy_p);
    const sp = Number(t && t.sell_p);
    if (!date || !isFinite(bp) || !isFinite(sp)) {
      throw new Error(`第 ${i + 1} 笔交易缺少合法的 date / buy_p / sell_p`);
    }
    return { date, buy_p: +bp.toFixed(3), sell_p: +sp.toFixed(3) };
  });
}

module.exports = { runCustomStrategy, TIMEOUT_MS };
