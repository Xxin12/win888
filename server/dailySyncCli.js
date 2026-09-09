'use strict';
/**
 * 每日收盘后行情数据补齐 —— 命令行入口
 * 供 WorkBuddy 每日固定触发自动化 / 手动执行调用。
 *
 * 用法:
 *   node server/dailySyncCli.js                正常补齐(仅本地已有数据的股票)
 *   node server/dailySyncCli.js --dry-run      演练: 只统计范围, 不落库、不发通知
 *   node server/dailySyncCli.js --force        强制重跑(忽略"已补齐"守卫)
 *   node server/dailySyncCli.js --all          全市场补全"最新一天"(含本地无数据的股票)
 *
 * 退出码: 成功 0 / 失败 1 / 已跳过 2
 */
const dailySync = require('./lib/dailySync');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run') || args.includes('-n');
const force = args.includes('--force') || args.includes('-f');
const all = args.includes('--all') || args.includes('-a');
const scope = all ? 'all' : 'existing';

(async () => {
  console.log('[dailySyncCli] 启动', JSON.stringify({ dryRun, force, scope }));
  try {
    const r = await dailySync.runDailySync({ dryRun, force, scope });
    console.log('[dailySyncCli] 完成:', JSON.stringify({
      ok: r.ok, skipped: r.skipped, reason: r.reason,
      latestDay: r.latestDay, total: r.total,
      dayAdded: r.dayAdded, m5Added: r.m5Added,
      intradayDays: r.intradayDays, intradayPoints: r.intradayPoints,
      failed: r.failed, durationMs: r.durationMs,
    }, null, 2));
    // 真实运行(非演练)才发企微通知
    if (!dryRun) {
      const n = await dailySync.notify(r);
      console.log('[dailySyncCli] 企微通知:', JSON.stringify(n));
    }
    process.exit(r.ok ? (r.skipped ? 2 : 0) : 1);
  } catch (e) {
    console.error('[dailySyncCli] 异常:', e.message);
    process.exit(1);
  }
})();
