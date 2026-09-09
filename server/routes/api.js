'use strict';
const express = require('express');
const { computeAll } = require('../lib/indicators');
const tencent = require('../providers/tencent');
const intraday = require('../lib/intradayRecorder');
const progress = require('../lib/backfillProgress');
const tdxGateway = require('../lib/tdxGatewayManager');
const { probeAll } = require('../lib/dataSourceProbe');
const { loadBarsCached } = require('../lib/klineService');
const universe = require('../lib/stockUniverse');
const indices = require('../lib/indices');
const bulk = require('../lib/bulkBackfill');

module.exports = function createApi(realtime) {
  const r = express.Router();
  const short = (c) => String(c).replace(/^(sh|sz|bj)/, '');
  const gstore = require('../lib/globalStore');   // 自选/持仓/预警/通知日志(全局 SQLite)
  const ms = require('../lib/marketStore');        // 时序数据(按股票隔离 SQLite)
  const { prefixOf } = require('../lib/db');
  const system = require('../lib/system');
  const dailySync = require('../lib/dailySync');
  const tradeCal = require('../lib/tradeCalendar');

  // K线/指标的加载与"收盘后本地优先"逻辑已抽到 server/lib/klineService.js(供批量回补复用)
  // —— 此处仅通过 loadBarsCached 调用, 避免重复实现。

  // ---- 实时报价 (WS快照兜底 -> 直连) ----
  r.get('/quote', async (req, res) => {
    const codes = (req.query.codes || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!codes.length) return res.json({ ok: true, data: [] });
    try {
      const data = await tencent.getQuotes(codes);
      res.json({ ok: true, live: true, data });
    } catch (e) {
      res.json({ ok: true, live: false, data: realtime.getSnapshot(codes), error: e.message });
    }
  });

  // ---- 构建版本号(前端轮询, 检测新构建后自动重载, 解决 SPA 跨轮跑旧 bundle) ----
  r.get('/version', (req, res) => {
    try { res.json({ ok: true, version: require('fs').readFileSync(require('path').join(__dirname, '..', 'public', '.version'), 'utf8').trim() }); }
    catch (e) { res.json({ ok: false, version: null }); }
  });

  // ---- 代码解析: 数字代码 -> 标准代码 + 名称 ----
  r.get('/stock/resolve', async (req, res) => {
    const raw = (req.query.code || '').trim();
    if (!raw) return res.json({ ok: false, error: 'code required' });
    const nc = tencent.normCode(raw);
    try {
      const q = (await tencent.getQuotes([nc]))[0];
      res.json({ ok: true, code: nc, name: q && q.name ? q.name : nc });
    } catch (e) {
      res.json({ ok: true, code: nc, name: nc });
    }
  });

  // ---- 轻量健康检查(前端重启轮询用, 不触碰 DB) ----
  r.get('/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

  // ---- 重启整个服务(自重启: 拉起新进程并退出当前进程) ----
  r.post('/system/restart', (req, res) => {
    if (system.isRestarting()) return res.json({ ok: false, msg: '重启已在进行中' });
    const ok = system.restartSelf();
    if (ok) return res.json({ ok: true, msg: '正在重启服务...' });
    return res.json({ ok: false, msg: '重启失败' });
  });

  // ---- K线: 日/5分 (实时优先+合并历史) ----
  r.get('/kline', async (req, res) => {
    const code = req.query.code || 'sz002027';
    const period = req.query.period || 'day';
    try {
      const { bars, source } = await loadBarsCached(code, period);
      const n = Number(req.query.limit) || (period === '5m' ? 960 : 320);
      res.json({ ok: true, period, code, source, data: bars.slice(-n) });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message, data: [] });
    }
  });

  // ---- 指标 ----
  // 在全量历史上计算(保证 MA60 等准确), 再切片到与K线相同的条数, 避免长度错配
  const sliceTail = (obj, n) => {
    if (Array.isArray(obj)) return obj.slice(-n);
    if (obj && typeof obj === 'object') { const o = {}; for (const k in obj) o[k] = sliceTail(obj[k], n); return o; }
    return obj;
  };
  r.get('/indicators', async (req, res) => {
    const code = req.query.code || 'sz002027';
    const period = req.query.period || 'day';
    const types = (req.query.types || 'MA,MACD,KDJ,BOLL').split(',');
    const limit = Number(req.query.limit) || (period === '5m' ? 960 : 250);
    try {
      const { bars } = await loadBarsCached(code, period);
      const ind = computeAll(bars, types);
      res.json({ ok: true, code, period, source: bars.length ? 'live' : 'empty', indicators: sliceTail(ind, limit) });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // ---- 分时 ----
  // 当日分时按 A 股交易时段裁剪(09:25~11:30 / 13:00~15:00), 剔除腾讯在收盘后补齐到 15:30
  // 的盘后幽灵分钟 —— 这些多余点会让看盘页当日分时尾盘出现水平线, 并把"收盘价"错误拖到 15:30,
  // 与实际收盘价不符。此为读路径兜底: 即使本地历史缓存里已含幽灵尾, 展示时也会被过滤掉。
  const inSession = (t) => (t >= '09:25' && t <= '11:30') || (t >= '13:00' && t <= '15:00');
  const trimTodaySession = (rows) => (Array.isArray(rows) ? rows.filter((x) => inSession(x.t || x.time)) : rows);
  r.get('/minute', async (req, res) => {
    const code = req.query.code || 'sz002027';
    const date = req.query.date; // 可选: 指定历史日期 -> 返回已落盘的分时
    try {
      if (date) {
        // 历史日: 本地优先; 缺失则提示回补(分时历史只能经回补落盘, 实时接口仅给当日)
        const saved = intraday.loadDate(code, date);
        if (saved) return res.json({ ok: true, code, date, source: 'local', preclose: localPrevClose(code, date), data: saved.rows });
        return res.json({ ok: false, code, date, source: 'local', error: '该日分时未保存(可经「回补」补抓)', data: [] });
      }
      const today = intraday.todayStr();
      const isTradingDate = tradeCal.weekdayTradingDay(today);
      const pc = localPrevClose(code, today); // 本地日K昨收(振幅%基准, 含多年历史)
      // 收盘后: 本地优先(本地已有当日完整分时则直接返回, 不再打接口)
      if (intraday.isMarketClosed(today)) {
        const saved = intraday.loadDate(code, today);
        if (saved) return res.json({ ok: true, code, date: today, source: 'local', preclose: pc, data: trimTodaySession(saved.rows) });
        // 本地无当日 -> 仅"交易日收盘后"才回退实时抓取并落盘(保证有数据);
        //   周末/节假日并非交易日, 实时接口只会返回上一交易日数据, 若在此落盘会把
        //   "非交易日"写进日期库、污染"当日分时"日期选项 -> 直接返回空, 不保存。
        if (!isTradingDate) {
          return res.json({ ok: true, code, date: today, source: 'empty', preclose: pc, data: [] });
        }
      }
      // 盘中或本地缺失: 实时拉取(腾讯)并落盘(仅交易日才会落盘, 收盘后即成为完整一日)
      const data = await tencent.getMinute(code);
      if (data.length && isTradingDate) intraday.saveToday(code, data);
      res.json({ ok: true, code, date: intraday.todayStr(), source: 'live', preclose: pc, data: trimTodaySession(data) });
    } catch (e) {
      res.json({ ok: false, error: e.message, data: [] });
    }
  });

  // ---- 分时历史日期列表(供前端日期选择器) ----
  // 仅返回交易日: 剔除周末/节假日等非交易日。原因——实时回退抓取曾把"上一交易日"数据
  // 误存成非交易日日期(周末/节假日 today 无本地数据 -> 实时拉取落盘), 导致"当日分时"
  // 日期下拉出现非交易日选项。此处用系统统一的交易日定义(weekdayTradingDay)过滤, 保证
  // 下拉只出现有效交易日的已落盘数据。(边界: 仅服务于实时看盘·当日分时板块)
  r.get('/intraday/dates', (req, res) => {
    const code = req.query.code || 'sz002027';
    try {
      const dates = intraday.listDates(code).filter((d) => tradeCal.weekdayTradingDay(d));
      res.json({ ok: true, code, dates });
    } catch (e) {
      res.json({ ok: false, error: e.message, dates: [] });
    }
  });

  // ---- 分时图 + 大盘指数叠加 (边界: 仅实时看盘·当日分时板块) ----
  // 返回个股与其"交易所对应大盘指数"的分时涨跌幅(%), 均以昨收为 0 中心,
  // 二者共用同一纵坐标对比强弱。指数仅当日实时可叠加(历史日本地无指数分时, 不叠加)。
  // 全程走腾讯直连(快), 不碰 TDX 网关(慢), 指数也不查本地库(本地库不含指数)。
  function indexCodeFor(code) {
    const p = String(code || '').slice(0, 2);
    if (p === 'sh') return 'sh000001'; // 上证指数
    if (p === 'sz') return 'sz399001'; // 深证成指
    if (p === 'bj') return 'bj899050'; // 北证50
    return 'sh000001';
  }
  // 由日K(腾讯直连)推算某显示日对应的"昨收"(= 该显示日之前最近交易日的收盘)
  async function prevCloseFromDayK(code, displayedDate) {
    try {
      const bars = await tencent.getDayKline(code, 15);
      if (bars && bars.length) {
        const sorted = [...bars].sort((a, b) => (a.date < b.date ? -1 : 1));
        let pc = null;
        for (const b of sorted) { if (b.date < displayedDate) pc = b.close; else break; }
        if (pc != null) return pc;
      }
    } catch (_) { /* ignore */ }
    // 兜底: 实时报价昨收(对北交所等日K未覆盖的标的)
    try {
      const q = await tencent.getQuotes([code]);
      if (q && q[0] && q[0].preclose) return q[0].preclose;
    } catch (_) { /* ignore */ }
    return null;
  }
  // 分时振幅%的「昨收」基准。关键：本地日K是【前复权】存储的, 而分时(分时)数据是【未复权/raw】的,
  // 两者尺度不同(除权除息导致日K历史价被下调)。若用日K前复权收盘作基准, 会相对 raw 分时价产生
  // 系统性 ~3% 偏差(如 2026-07-09 除息前的日期振幅整体虚高)。
  // 因此优先用【上一交易日的原始分时末价】(raw, 与当日分时同尺度)作昨收; 仅当上一交易日无分时落盘
  // (如最早一条分时之前)才兜底用日K收盘(前复权, 有偏差但至少有一个数值)。
  function localPrevClose(code, displayed) {
    try {
      const dates = ms.listIntradayDates(code); // 降序(最新在前)
      let prev = null;
      for (const d of dates) { if (d < displayed) { prev = d; break; } } // 第一个 < displayed 即上一交易日
      if (prev) {
        const rec = ms.getIntraday(code, prev);
        if (rec && rec.rows && rec.rows.length) return +Number(rec.rows[rec.rows.length - 1].price).toFixed(2);
      }
    } catch (_) { /* ignore */ }
    try {
      // 兜底：上一交易日无分时落盘时, 用本地日K收盘(前复权)近似
      const bars = ms.getDayBars(code);
      if (bars && bars.length) {
        let pc = null;
        for (const b of bars) { if (b.date < displayed) pc = b.close; else break; }
        if (pc != null) return +Number(pc).toFixed(2);
      }
    } catch (_) { /* ignore */ }
    return null;
  }
  r.get('/intraday/compare', async (req, res) => {
    const code = req.query.code || 'sz002027';
    const date = req.query.date; // 可选历史日; 不传=今日实时
    try {
      const today = intraday.todayStr();
      const displayed = date || today;
      const indexCode = indexCodeFor(code);
      const indexName = (indices.MAJOR_INDICES.find((x) => x.code === indexCode) || {}).name || indexCode;
      // 个股分时: 历史日走本地落盘, 今日实时走腾讯
      let stockRows = null;
      if (date) { const saved = intraday.loadDate(code, date); stockRows = saved ? saved.rows : null; }
      else { stockRows = await tencent.getMinute(code); }
      if (!stockRows || !stockRows.length) {
        return res.json({ ok: true, code, date: displayed, index: { code: indexCode, name: indexName, available: false }, stock: { points: [] } });
      }
      const stockPrev = await prevCloseFromDayK(code, displayed);
      // 指数分时: 仅当日实时可叠加; 历史日无本地指数分时 -> 不叠加
      let indexRows = null;
      if (!date) { try { indexRows = await tencent.getMinute(indexCode); } catch (_) { indexRows = null; } }
      const indexPrev = (indexRows && indexRows.length) ? await prevCloseFromDayK(indexCode, displayed) : null;
      // 指数按 t 对齐成查表(涨跌幅%)
      const idxByT = {};
      if (indexRows && indexPrev) indexRows.forEach((r) => { idxByT[r.t] = (r.price - indexPrev) / indexPrev * 100; });
      const stockPoints = stockRows.map((r) => ({
        t: r.t,
        pct: stockPrev ? (r.price - stockPrev) / stockPrev * 100 : null,
        ipct: (r.t in idxByT) ? idxByT[r.t] : null,
      }));
      res.json({
        ok: true, code, date: displayed,
        index: { code: indexCode, name: indexName, prevClose: indexPrev, available: !!(indexRows && indexRows.length) },
        stock: { prevClose: stockPrev, points: stockPoints },
      });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // ---- 从历史接口回补最近 N 个交易日分时并落盘(可插拔数据源 + 频率限制) ----
  // 说明: 回补是长任务(TDX 可能 60 页串行×2s≈2 分钟), 故 POST 不阻塞 —— 立即返回
  //       { started:true } 或 { skipped:true }, 真实进度由 recorder 写入 progress 存储,
  //       前端轮询 GET /intraday/backfill/progress 显示进度条。
  r.post('/intraday/backfill', (req, res) => {
    const body = req.body || {};
    const code = body.code || req.query.code;
    if (!code) return res.json({ ok: false, error: 'code 必填' });
    // 回补深度不做上限封顶(仅保证 >=1); 真实深度由 recorder 结合本地已有数据与服务器数据下限决定
    const days = Math.max(parseInt(body.days || 5, 10) || 5, 1);
    // 日期区间模式: 同时传入合法 YYYY-MM-DD 的 start/end 时启用
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const start = typeof body.start === 'string' && dateRe.test(body.start) ? body.start : null;
    const end = typeof body.end === 'string' && dateRe.test(body.end) ? body.end : null;
    // 未显式指定 source 时, 采用「数据源配置」里的历史分时回补默认源
    const source = ['eastmoney', 'tdx'].includes(body.source) ? body.source : require('../lib/dataSource').readConfig().intradayBackfill;
    const rangeMode = !!(start && end);
    // 已有同 code 回补在进行 → 立即返回 skipped, 前端继续轮询已有进度
    if (progress.isActive(code)) {
      return res.json({ ok: true, started: false, skipped: true, code, source, rangeMode });
    }
    // 异步触发, 不阻塞响应; 进度由 recorder → progress 存储, 前端轮询
    intraday.backfill(code, { days, source, start, end }).catch((e) => {
      progress.finish(code, { ok: false, error: e.message });
    });
    res.json({ ok: true, started: true, code, source, rangeMode });
  });

  // ---- 回补实时进度(供前端进度条轮询) ----
  r.get('/intraday/backfill/progress', (req, res) => {
    const code = req.query.code || '';
    if (!code) return res.json({ ok: false, error: 'code 必填' });
    const p = progress.get(code);
    if (!p) return res.json({ ok: true, active: false });
    res.json({ ok: true, active: true, ...p });
  });

  // ---- A股全市场股票列表(行情中心) ----
  r.get('/stocks', async (req, res) => {
    try {
      const u = await universe.getUniverse();
      res.json({ ok: true, updated: u.updated, count: u.count, stocks: u.stocks, source: u.source, error: u.error });
    } catch (e) {
      res.json({ ok: false, error: e.message, stocks: [] });
    }
  });
  // 强制刷新列表(重新从东财拉取)
  r.post('/stocks/refresh', async (req, res) => {
    try {
      const u = await universe.getUniverse({ force: true });
      res.json({ ok: true, updated: u.updated, count: u.count, stocks: u.stocks, source: u.source, error: u.error });
    } catch (e) {
      res.json({ ok: false, error: e.message, stocks: [] });
    }
  });
  // ---- 大盘各类指数列表(行情中心「大盘指数」分类; 与 A股股票池解耦, 不污染 dailySync/看盘页) ----
  // 返回带本地数据覆盖(分时/5分/日线)装饰的索引清单, 直接复用行情中心表格与回补按钮。
  r.get('/indices', (req, res) => {
    try {
      const list = indices.getIndices();
      res.json({ ok: true, count: list.length, indices: list });
    } catch (e) {
      res.json({ ok: false, error: e.message, indices: [] });
    }
  });
  // 批量查询本地数据覆盖情况(供行情页标记"已有/缺失"); 直接查 global.db.stock_coverage 表,
  // 按 code IN (...) 一次命中, 不打开任何单只股票的 .db 文件; 未回补股票 seed 默认行返回 0。
  r.get('/stocks/coverage', (req, res) => {
    const codes = (req.query.codes || '').split(',').map((s) => s.trim()).filter(Boolean);
    const map = gstore.getCoverageMap(codes);
    const out = {};
    for (const code of codes) {
      const c = map.get(code);
      out[code] = c ? { has5min: !!c.has5min, hasDay: !!c.hasDay, intradayDates: c.intradayDates || 0 }
                    : { has5min: 0, hasDay: 0, intradayDates: 0 };
    }
    res.json({ ok: true, coverage: out });
  });
  // 全量本地数据覆盖(行情中心"无本地数据"筛选用): 一次返回所有股票的 has5min/hasDay/intradayDates,
  // 单条 SQL 毫秒级; 前端据此做市场级"缺失本地数据"筛选, 无需逐页拉取。
  r.get('/stocks/coverage-all', (req, res) => {
    try {
      const map = gstore.getAllCoverage();
      res.json({ ok: true, coverage: map });
    } catch (e) {
      res.json({ ok: false, error: e.message, coverage: {} });
    }
  });

  // ---- 批量回补(分型: 分时 / 5分钟 / 日线) ----
  // POST { type:'intraday'|'5min'|'day', source?, codes?, force? } -> 立即返回 started/skipped
  //    codes 省略 = 回补全市场; force=true 对 5min/day 强制重抓(默认跳过本地已有)
  // 进度轮询: GET /backfill-bulk/status
  r.post('/backfill-bulk', (req, res) => {
    const b = req.body || {};
    const type = ['intraday', '5min', 'day'].includes(b.type) ? b.type : null;
    if (!type) return res.json({ ok: false, error: 'type 必填: intraday | 5min | day' });
    const source = typeof b.source === 'string' ? b.source : undefined;
    const codes = Array.isArray(b.codes) ? b.codes.filter(Boolean) : [];
    const force = !!b.force;
    // 分时历史回补深度/区间(与单只历史回补一致): days(正整数, 全量哨兵5000) / 日期区间(start,end YYYY-MM-DD)
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const days = (type === 'intraday' && b.days) ? Math.max(parseInt(b.days, 10) || 5000, 1) : undefined;
    const start = (type === 'intraday' && typeof b.start === 'string' && dateRe.test(b.start)) ? b.start : undefined;
    const end = (type === 'intraday' && typeof b.end === 'string' && dateRe.test(b.end)) ? b.end : undefined;
    // targeted: 1=「分时定向回补」(对比缺失日期补缺, 不做整只跳过); 仅前端专属按钮传入, 与实时看盘单只回补一致
    const targeted = !!(type === 'intraday' && b.targeted);
    const r2 = bulk.startJob(type, { source, codes, force, days, start, end, targeted });
    res.json({ ok: true, ...r2, type });
  });
  r.get('/backfill-bulk/status', (req, res) => {
    const st = bulk.getStatus();
    // 扁平化: jobs 保持数组(前端轮询兼容), 并列返回 logs / lastResults / 队列(queue, queueLength)
    res.json({ ok: true, jobs: st.jobs, logs: st.logs, lastResults: st.lastResults, queue: st.queue, queueLength: st.queueLength, draining: st.draining });
  });

  // ---- 数据源配置 (读/写/实测) ----
  r.get('/datasource/config', (req, res) => {
    res.json({ ok: true, config: require('../lib/dataSource').readConfig(), catalog: require('../lib/dataSource').CATALOG, channels: require('../lib/dataSource').CHANNELS, liveIntraday: require('../lib/dataSource').LIVE_INTRADAY, defaults: require('../lib/dataSource').DEFAULTS });
  });
  r.post('/datasource/config', (req, res) => {
    try { res.json({ ok: true, config: require('../lib/dataSource').saveConfig(req.body || {}) }); }
    catch (e) { res.status(200).json({ ok: false, error: e.message }); }
  });
  // 逐个真实调用各源, 返回实测范围(用户可在本机确认真实数据能力, 避免错误配置)
  r.get('/datasource/test', async (req, res) => {
    const code = tencent.normCode(req.query.code || 'sz002027');
    try { res.json({ ok: true, code, results: await probeAll(code), ts: new Date().toISOString() }); }
    catch (e) { res.status(200).json({ ok: false, error: e.message }); }
  });

  // ---- 自选 (SQLite: global.db.watchlist) ----
  r.get('/watchlist', (req, res) => res.json({ ok: true, data: gstore.getWatchlist() }));
  r.post('/watchlist', async (req, res) => {
    const { code, name, group } = req.body || {};
    if (!code) return res.status(400).json({ ok: false, error: 'code required' });
    const nc = tencent.normCode(code);
    const exists = gstore.getWatchlist().find((x) => x.code === nc);
    if (!exists) {
      let nm = name || '';
      if (!nm) {
        try { const q = (await tencent.getQuotes([nc]))[0]; nm = q && q.name ? q.name : nc; } catch (_) { nm = nc; }
      }
      gstore.addWatchlist({ code: nc, name: nm, group: group || '默认' });
      realtime.setDefaultSubs([nc]);
    }
    res.json({ ok: true, data: gstore.getWatchlist() });
  });
  r.delete('/watchlist/:code', (req, res) => {
    const nc = tencent.normCode(req.params.code);
    gstore.removeWatchlist(nc);
    res.json({ ok: true, data: gstore.getWatchlist() });
  });

  // ---- 预警 (SQLite: global.db.alert) ----
  r.get('/alerts', (req, res) => res.json({ ok: true, data: gstore.getAlerts() }));
  r.post('/alerts', (req, res) => {
    const a = req.body || {};
    a.code = tencent.normCode(a.code);
    a.enabled = a.enabled !== false; a.triggered = false; a.lastHit = null;
    gstore.addAlert(a);
    res.json({ ok: true, data: gstore.getAlerts() });
  });
  r.delete('/alerts/:id', (req, res) => {
    gstore.removeAlert(req.params.id);
    res.json({ ok: true, data: gstore.getAlerts() });
  });
  // 评估预警(结合实时快照)
  r.get('/alerts/evaluate', async (req, res) => {
    const list = gstore.getAlerts();
    const codes = [...new Set(list.map((a) => a.code))];
    let quotes = [];
    try { quotes = await tencent.getQuotes(codes); } catch (_) { quotes = realtime.getSnapshot(codes); }
    const qmap = new Map(quotes.map((q) => [q.code, q]));
    const hits = [];
    list.forEach((a) => {
      if (!a.enabled) return;
      const q = qmap.get(a.code); if (!q) return;
      const val = a.type === 'change_pct' ? q.change_pct : q.price;
      const hit = a.op === '<=' ? val <= a.value : val >= a.value;
      if (hit) { a.triggered = true; a.lastHit = q._recv || q.time; hits.push({ ...a, current: val, name: q.name }); }
    });
    gstore.updateAlerts(list);
    res.json({ ok: true, hits });
  });

  // ---- 回测 ----
  r.post('/backtest', async (req, res) => {
    try { res.json(await require('../backtest/engine').runBacktest(req.body || {})); }
    catch (e) { res.status(200).json({ ok: false, error: e.message }); }
  });

  // ---- 日线手动导入: 将前端解析后的日线写入本地 SQLite(kline_day) ----
  // body: { code:'sz002027', bars:[{date,open,high,low,close,volume,amount}] }
  r.post('/import/dayline', (req, res) => {
    try {
      const body = req.body || {};
      const code = String(body.code || '').toLowerCase().trim();
      if (!/^(sh|sz|bj)\d{6}$/.test(code)) return res.json({ ok: false, error: '股票代码格式应为 sh/sz/bj + 6位数字，当前: ' + code });
      const { cleanBars } = require('../backtest/dca');
      const cleaned = cleanBars(Array.isArray(body.bars) ? body.bars : [], body.priceType);
      if (!cleaned.bars.length) return res.json({ ok: false, error: '无有效日线数据可写入', warnings: cleaned.warnings });
      const before = (ms.getDayBars(code) || []).length;
      const written = ms.saveDayBars(code, cleaned.bars.map((b) => ({
        date: b.date, open: b.open, high: b.high, low: b.low, close: b.close,
        volume: b.volume, amount: b.amount, turnover: 0,
      })));
      const after = (ms.getDayBars(code) || []).length;
      res.json({
        ok: true, code, written, before, after,
        from: cleaned.bars[0].date, to: cleaned.bars[cleaned.bars.length - 1].date,
        skipped: cleaned.skipped, warnings: cleaned.warnings,
      });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ---- 分红/转增查询(红利再投用) ----
  // GET /api/dividend/:code  → 拉取(新浪)并落库, 返回该代码全部已实施分红事件
  r.get('/dividend/:code', async (req, res) => {
    try {
      const code = String(req.params.code || '').toLowerCase().trim();
      if (!/^(sh|sz|bj)\d{6}$/.test(code)) return res.json({ ok: false, error: '股票代码格式应为 sh/sz/bj + 6位数字，当前: ' + code });
      const { fetchDividend } = require('../providers/dividend');
      let list = [];
      try { list = await fetchDividend(code); } catch (e) { return res.json({ ok: false, error: '分红数据获取失败: ' + e.message }); }
      if (list.length) gstore.saveDividends(code, list);
      const local = gstore.getDividends(code);
      res.json({ ok: true, code, count: local.length, dividends: local });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ---- 回测: 单日分时数据(供买卖点在分时图叠加展示) ----
  // 优先返回已落盘 1 分钟分时; 若无则回退该日 5 分钟棒重建为分时序列。
  r.get('/backtest/day', (req, res) => {
    const code = req.query.code || '';
    const date = req.query.date || '';
    if (!code || !date) return res.json({ ok: false, error: 'code & date required', data: [] });
    try {
      const intra = intraday.loadDate(code, date);
      if (intra && intra.rows && intra.rows.length) {
        return res.json({ ok: true, code, date, source: 'intraday', data: intra.rows });
      }
      const allK5 = ms.get5minBars(code);
      const bars = allK5.filter((b) => b.date === date);
      if (bars.length) {
        // 5分钟回退: 用 成交额/成交量 重建当日均价(累计 VWAP); volume 单位为「手」, 故 /100 还原为「股」
        let cumA = 0, cumV = 0;
        const data = bars.map((b) => {
          cumA += (b.amount || 0);
          cumV += (b.volume || 0);
          const avg = cumV > 0 ? +(cumA / (cumV * 100)).toFixed(3) : b.close;
          return { t: b.datetime.slice(11, 16), price: b.close, avg, volume: b.volume, open: b.open, high: b.high, low: b.low, close: b.close };
        });
        return res.json({ ok: true, code, date, source: 'k5', data });
      }
      return res.json({ ok: false, code, date, error: '该日无分时/5分钟数据', data: [] });
    } catch (e) { res.json({ ok: false, error: e.message, data: [] }); }
  });

  // ---- 回测: 可标注分时日期(手动买卖点用) ----
  // 默认返回 已落盘1分钟分时日期 ∪ 5分钟棒日期(降序)。
  // ?intraday=1 时仅返回"已落盘1分钟分时"日期 —— 手动买卖点必须基于分钟级(intraday)数据, 故前端用手动模式时只取这些。
  r.get('/backtest/dates', (req, res) => {
    const code = req.query.code || '';
    const intradayOnly = req.query.intraday === '1';
    if (!code) return res.json({ ok: true, code, dates: [], intraday: [] });
    try {
      const intra = (intraday.listDates(code) || []).slice().sort().reverse();
      const k5 = Array.from(new Set(ms.get5minBars(code).map((b) => b.date)));
      const all = Array.from(new Set([...intra, ...k5])).sort().reverse();
      const dates = intradayOnly ? intra : all;
      res.json({ ok: true, code, dates, intraday: intra, all });
    } catch (e) { res.json({ ok: false, error: e.message, dates: [], intraday: [] }); }
  });

  // ---- 回测: 自定义/手动策略库 (持久化到 global.db.custom_strategies) ----
  const strategyStore = require('../backtest/strategyStore');
  r.get('/backtest/strategies', (req, res) => {
    try { res.json({ ok: true, data: strategyStore.list() }); }
    catch (e) { res.json({ ok: false, error: e.message, data: [] }); }
  });
  r.post('/backtest/strategies', (req, res) => {
    try {
      const b = req.body || {};
      if (!b.name || !b.type) return res.json({ ok: false, error: 'name & type required' });
      const id = strategyStore.save({
        name: String(b.name).slice(0, 60),
        type: b.type === 'manual' ? 'manual' : 'code',
        stock_code: b.stock_code || '',
        js_code: b.type === 'manual' ? '' : (b.js_code || ''),
        marks: b.type === 'manual' ? (b.marks || []) : [],
        qty: Number(b.qty) || null,
        windowDays: Number(b.windowDays) || null,
        summary: b.summary || null,
      });
      res.json({ ok: true, id });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  r.delete('/backtest/strategies', (req, res) => {
    try { strategyStore.remove(Number(req.query.id)); res.json({ ok: true }); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ---- 持仓 (SQLite: global.db.portfolio) ----
  r.get('/portfolio', async (req, res) => {
    const list = gstore.getPortfolio();
    const codes = list.map((x) => tencent.normCode(x.code));
    let quotes = [];
    try { quotes = await tencent.getQuotes(codes); } catch (_) { quotes = realtime.getSnapshot(codes); }
    const qmap = new Map(quotes.map((q) => [q.code, q]));
    const rows = list.map((x) => {
      const nc = tencent.normCode(x.code);
      const q = qmap.get(nc);
      const price = q ? q.price : null;
      const mktVal = price ? +(price * x.shares).toFixed(2) : null;
      const costVal = +(x.cost * x.shares).toFixed(2);
      const pnl = price ? +((price - x.cost) * x.shares).toFixed(2) : null;
      const pnlPct = price ? +(((price - x.cost) / x.cost) * 100).toFixed(2) : null;
      return { ...x, code: nc, price, change_pct: q ? q.change_pct : null, mktVal, costVal, pnl, pnlPct };
    });
    res.json({ ok: true, data: rows });
  });
  r.post('/portfolio', (req, res) => {
    const list = Array.isArray(req.body) ? req.body : (req.body?.data || []);
    const norm = list.map((x) => ({ ...x, code: tencent.normCode(x.code) }));
    gstore.setPortfolio(norm);
    res.json({ ok: true, data: gstore.getPortfolio() });
  });

  // ---- 资讯: F10 / 资金流 / 新闻 (best-effort, 失败给占位) ----
  r.get('/f10', async (req, res) => {
    const code = req.query.code || 'sz002027';
    try {
      const q = (await tencent.getQuotes([code]))[0] || {};
      res.json({ ok: true, code, data: {
        name: q.name, price: q.price, pe: q.pe, turnover: q.turnover,
        market_cap: q.market_cap, float_cap: q.float_cap,
        high: q.high, low: q.low, open: q.open, preclose: q.preclose,
      }});
    } catch (e) { res.json({ ok: false, error: e.message, data: {} }); }
  });
  r.get('/fundflow', async (req, res) => {
    const code = req.query.code || 'sz002027';
    try {
      const c = tencent.normCode(code);
      const url = `https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get?_var=&param=${c},ff,,,10`;
      const rr = await fetch(url).catch(() => null);
      let data = [];
      if (rr && rr.ok) { try { const j = await rr.json(); data = j?.data?.[c]?.ff || []; } catch (_) {} }
      res.json({ ok: true, code: c, data });
    } catch (e) { res.json({ ok: false, error: e.message, data: [] }); }
  });
  r.get('/news', async (req, res) => {
    const sc = short(req.query.code || 'sz002027');
    const code = prefixOf(sc) + sc;
    res.json({ ok: true, data: ms.getNews(code) });
  });

  // ---- 企业微信通知配置 / 发送 ----
  r.get('/wecom-config', (req, res) => res.json({ ok: true, data: require('../lib/wecom').readConfig() }));
  r.post('/wecom-config', (req, res) => {
    try {
      const cfg = require('../lib/wecom').saveConfig(req.body || {});
      res.json({ ok: true, data: cfg });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message });
    }
  });
  // 接收前端信号触发: { type:'bottom'|'top', code, name }
  r.post('/notify', async (req, res) => {
    const p = req.body || {};
    if (p.type !== 'bottom' && p.type !== 'top') {
      return res.status(200).json({ ok: false, error: 'type must be bottom|top' });
    }
    const r2 = await require('../lib/wecom').sendNotify({
      type: p.type, code: p.code, name: p.name,
      price: p.price, avg: p.avg, time: p.time,
      images: Array.isArray(p.images) ? p.images : (p.image ? [p.image] : []),
    });
    res.json({ ok: r2.ok, mode: r2.mode, results: r2.results, reason: r2.reason, error: r2.error });
  });

  // --------------------------------------------------- TDX 网关管理 (Web 启停 pytdx 子进程)
  r.get('/tdx-gateway/config', (req, res) => res.json({ ok: true, data: tdxGateway.loadConfig(), defaults: tdxGateway.DEFAULTS }));
  r.post('/tdx-gateway/config', (req, res) => {
    try {
      const cfg = tdxGateway.saveConfig(req.body || {});
      res.json({ ok: true, data: cfg });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message });
    }
  });
  r.post('/tdx-gateway/start', async (req, res) => {
    const r2 = await tdxGateway.start();
    res.json(r2);
  });
  r.post('/tdx-gateway/stop', (req, res) => {
    res.json(tdxGateway.stop());
  });
  r.get('/tdx-gateway/status', (req, res) => {
    res.json({ ok: true, data: tdxGateway.status() });
  });
  r.get('/tdx-gateway/deps', async (req, res) => {
    const deps = await tdxGateway.checkDeps();
    res.json({ ok: true, data: deps });
  });

  // ---- 本地数据库浏览 / 编辑(通用 SQLite 管理) ----
  const dbm = require('../lib/dbManager');
  // 已存在的个股 .db 文件列表(代码)
  r.get('/db/stocks', (req, res) => { try { res.json({ ok: true, codes: dbm.listStockDbs() }); } catch (e) { res.json({ ok: false, error: e.message, codes: [] }); } });
  // 列出某库的表 + 字段结构 + 行数: scope=global|stock, code=个股代码(可空)
  r.get('/db/tables', (req, res) => {
    const scope = req.query.scope === 'stock' ? 'stock' : 'global';
    let code = req.query.code || '';
    try { if (scope === 'stock') code = dbm.normCode(code); res.json({ ok: true, scope, code, tables: dbm.listTables(scope, code) }); }
    catch (e) { res.json({ ok: false, error: e.message, tables: [] }); }
  });
  // 分页读取某表行: scope/code/table/page/pageSize/search
  r.get('/db/rows', (req, res) => {
    const scope = req.query.scope === 'stock' ? 'stock' : 'global';
    const { table } = req.query;
    let code = req.query.code || '';
    try {
      if (scope === 'stock') code = dbm.normCode(code);
      const d = dbm.getRows(scope, code, table, { page: req.query.page, pageSize: req.query.pageSize, search: req.query.search || '' });
      res.json({ ok: true, scope, code, table, ...d });
    } catch (e) { res.json({ ok: false, error: e.message, rows: [], total: 0, columns: [] }); }
  });
  // 新增一行
  r.post('/db/row', (req, res) => {
    const b = req.body || {};
    const scope = b.scope === 'stock' ? 'stock' : 'global';
    let code = b.code || '';
    try {
      if (scope === 'stock') code = dbm.normCode(code);
      const r2 = dbm.insertRow(scope, code, b.table, b.values || {});
      res.json({ ok: true, ...r2 });
    } catch (e) { res.status(200).json({ ok: false, error: e.message }); }
  });
  // 更新一行(按主键)
  r.put('/db/row', (req, res) => {
    const b = req.body || {};
    const scope = b.scope === 'stock' ? 'stock' : 'global';
    let code = b.code || '';
    try {
      if (scope === 'stock') code = dbm.normCode(code);
      const r2 = dbm.updateRow(scope, code, b.table, b.pk || {}, b.values || {});
      res.json({ ok: true, ...r2 });
    } catch (e) { res.status(200).json({ ok: false, error: e.message }); }
  });
  // 删除一行(按主键, pk 为 JSON 对象)
  r.post('/db/row/delete', (req, res) => {
    const b = req.body || {};
    const scope = b.scope === 'stock' ? 'stock' : 'global';
    let code = b.code || '';
    try {
      if (scope === 'stock') code = dbm.normCode(code);
      const r2 = dbm.deleteRow(scope, code, b.table, b.pk || {});
      res.json({ ok: true, ...r2 });
    } catch (e) { res.status(200).json({ ok: false, error: e.message }); }
  });

  // ---- 每日收盘后行情数据补齐(固定触发任务) ----
  // 手动触发: POST { force?, dryRun?, scope? } -> 立即后台执行, 返回 started
  //   scope: 'existing'(默认, 仅补齐本地已有数据的股票) | 'all'(全市场补全最新一天)
  r.post('/daily-sync', (req, res) => {
    const b = req.body || {};
    if (dailySync.isRunning()) return res.json({ ok: true, started: false, skipped: true, reason: '每日补齐任务进行中' });
    dailySync.runDailySyncAndNotify({
      force: !!b.force,
      dryRun: !!b.dryRun,
      scope: b.scope === 'all' ? 'all' : 'existing',
    }).catch((e) => console.error('[daily-sync]', e.message));
    res.json({ ok: true, started: true });
  });
  // 状态 + 当日交易日判定
  r.get('/daily-sync/status', async (req, res) => {
    let td = null;
    try {
      const p = await tradeCal.detectLatestTradingDay();
      td = p ? { latestDay: p.date, ref: p.ref, isTradingDay: tradeCal.weekdayTradingDay(p.date) } : null;
    } catch (_) { /* ignore */ }
    res.json({
      ok: true,
      running: dailySync.isRunning(),
      status: dailySync.getStatus(),
      tradingDay: td,
      lastProcessedDay: (function () { try { return require('../lib/db').getMeta('daily_sync_last_day'); } catch (_) { return null; } })(),
    });
  });

  // ---- 日内做T分析（需求文档：量化系统_日内做T分析_需求文档.md） ----
  const dot = require('../lib/dotAnalysis');
  r.get('/dot/analyze', (req, res) => {
    const code = tencent.normCode(req.query.code || '');
    if (!code) return res.json({ ok: false, error: 'code required' });
    try { res.json({ ok: true, ...dot.analyze(code) }); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });
  r.get('/dot/day', (req, res) => {
    const code = tencent.normCode(req.query.code || '');
    const date = req.query.date || '';
    if (!code || !date) return res.json({ ok: false, error: 'code & date required' });
    try { res.json({ ok: true, ...dot.analyzeDay(code, date, dot.getThresholds()) }); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // 分时回放：返回原始分时行 + 盘后复盘顶底信号(含 discoveredAt)，用于验证盘中信号与盘后复盘是否匹配
  r.get('/dot/replay', (req, res) => {
    const code = tencent.normCode(req.query.code || '');
    const date = req.query.date || '';
    if (!code || !date) return res.json({ ok: false, error: 'code & date required' });
    try { res.json({ ok: true, ...dot.getReplay(code, date, dot.getThresholds(), !!req.query.pattern) }); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });
  r.get('/dot/compare', (req, res) => {
    const codes = (req.query.codes || '').split(',').map((s) => s.trim()).filter(Boolean).map((c) => tencent.normCode(c));
    if (!codes.length) return res.json({ ok: false, error: 'codes required' });
    try { res.json({ ok: true, ...dot.compareStocks(codes, dot.getThresholds()) }); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });
  r.get('/dot/backtest', (req, res) => {
    const code = tencent.normCode(req.query.code || '');
    if (!code) return res.json({ ok: false, error: 'code required' });
    try { res.json({ ok: true, ...dot.backtest(code, dot.getThresholds()) }); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });
  r.get('/dot/thresholds', (req, res) => { try { res.json({ ok: true, thresholds: dot.getThresholds() }); } catch (e) { res.json({ ok: false, error: e.message }); } });
  r.post('/dot/thresholds', (req, res) => {
    try { res.json({ ok: true, thresholds: dot.saveThresholds(req.body || {}) }); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });
  r.post('/dot/notify-today', async (req, res) => {
    const code = tencent.normCode((req.body && req.body.code) || req.query.code || '');
    if (!code) return res.json({ ok: false, error: 'code required' });
    try { res.json({ ok: true, ...(await dot.notifyToday(code, dot.getThresholds())) }); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // 分时顶底标记（实时看盘复用·与做T分析同一套检测逻辑）：缺省 date=今日(盘中进行中分时)，
  // 读取本地已落盘分时(盘中每15s由 /api/minute 落盘)后跑 detectTopsBottoms。
  r.get('/dot/tops-bottoms', (req, res) => {
    const code = tencent.normCode(req.query.code || '');
    const date = req.query.date || '';
    if (!code) return res.json({ ok: false, error: 'code required' });
    try {
      const th = dot.getThresholds();
      const today = intraday.todayStr();
      const target = date || today;
      const rec = ms.getIntraday(code, target);
      if (!rec || !rec.rows || !rec.rows.length) return res.json({ ok: false, reason: '分时未就绪', code, date: target });
      const tb = dot.detectTopsBottoms(rec.rows, th);
      res.json({ ok: true, code, date: target, live: !date, count: tb.length, marks: tb });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  return r;
};
