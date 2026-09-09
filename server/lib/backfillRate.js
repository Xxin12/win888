'use strict';
/**
 * 全局回补请求限流器 —— "每秒最多 1 次" (请求级节流)
 *
 * 为什么要它:
 *  - 回补是分页请求(TDX 一次可能几十页; 东财单次1页)。为防被数据源限流/封禁,
 *    需要保证"对外数据请求"的整体速率上限。
 *  - 与 backfillQueue(任务级串行) 互补: 队列保证"同一时刻只有一个回补任务",
 *    本限流器进一步保证"任意两次对外请求之间至少间隔 MIN_GAP_MS"。
 *
 * 用法:
 *  - 每次真正 fetch 之前 `await rate.acquire()`。acquire 会串行排队, 并在需要时
 *    sleep 到与上一次请求间隔满足 MIN_GAP_MS 为止。
 *
 * 配置:
 *  - 环境变量 BACKFILL_MIN_REQUEST_GAP_MS (默认 1000, 即每秒最多 1 次)。
 */
const MIN_GAP_MS = parseInt(process.env.BACKFILL_MIN_REQUEST_GAP_MS || '1000', 10);

let chain = Promise.resolve();
let lastTs = 0;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * 获取一个"请求配额": 串行排队, 保证与上一次 acquire 间隔 >= MIN_GAP_MS。
 * @returns {Promise<void>} resolve 后即可发起本次请求
 */
function acquire() {
  const p = chain.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastTs);
    if (wait > 0) await sleep(wait);
    lastTs = Date.now();
  });
  // 维持链不断裂(吞掉异常, acquire 本身不会 reject)
  chain = p.catch(() => {});
  return p;
}

module.exports = { acquire, MIN_GAP_MS };
