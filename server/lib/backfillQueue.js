'use strict';
/**
 * 回补任务串行队列 —— 频率限制核心
 *
 * 为什么需要它:
 *  - 东财 push2his(trends2) 对高频/并发请求会 socket 级限流(UND_ERR_SOCKET / fetch failed);
 *    通daxin(TDX) 对高频分页更是直接封禁。
 *  - 必须保证: 同一时刻只有一个回补任务在跑, 且任务之间留有最小间隔。
 *
 * 行为:
 *  - 串行执行: 任务以 Promise 链顺序执行, 绝不并发。
 *  - 防重入:   同一 key(如 `bf:600519`) 已在队列/进行中, 直接返回 {skipped:true}, 不重复入队。
 *  - 任务间最小间隔: 上一个任务完成后, 至少间隔 MIN_GAP_MS 才启动下一个(防东财 socket 限流)。
 *  - 任务内部 pacing(如 TDX 每页 sleep)由各 provider 自行负责, 本队列只管"任务级"节流。
 */
const inFlight = new Set();
let chain = Promise.resolve();
let lastDoneTs = 0;

// 任务间最小间隔(毫秒)。东财单次回补约 1 个 HTTP 请求, 留 1.2s 缓冲避免连续点击触发限流。
const MIN_GAP_MS = 1200;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * 入队一个回补任务
 * @param {string} key 去重键(如 `bf:600519`)
 * @param {Function} taskFn 返回 Promise 的任务函数(内部建议自带 pacing 与重试)
 * @returns {Promise<{skipped:true,key,reason}|any>}
 *   - key 已在进行中: { skipped:true, key, reason:'already_running' }
 *   - 否则: taskFn 的 resolve 值
 */
function enqueue(key, taskFn) {
  if (inFlight.has(key)) {
    return Promise.resolve({ skipped: true, key, reason: 'already_running' });
  }
  inFlight.add(key);
  const run = chain.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastDoneTs);
    if (wait > 0) await sleep(wait);
    return await taskFn();
  }).finally(() => {
    lastDoneTs = Date.now();
    inFlight.delete(key);
  });
  // 维持链不断裂: 吞掉 reject, 由 run 自身传递结果/错误给调用方
  chain = run.then(() => {}, () => {});
  return run;
}

function isRunning(key) { return inFlight.has(key); }

module.exports = { enqueue, isRunning, MIN_GAP_MS };
