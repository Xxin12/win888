import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { api, fmt, normCode, connectQuotes } from '../api';
import Chart, { klineOption, minuteOption, minuteDualAxisOption } from '../components/Chart';
import { computeIntradayT } from '../indicators/tIndex';
import TTDecisionPanel from '../components/TTDecisionPanel';
import StockSnapshot from '../components/StockSnapshot';
import html2canvas from 'html2canvas';

/** 本地(北京时区)今日 YYYY-MM-DD, 供日期区间回补的默认值与 max 约束 */
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 信号键: code|本地日期|type|信号时间(仅用于差值对比, 不再作持久化去重) */
function sigKeyOf(code, type, time) {
  return `${code}|${todayLocal()}|${type}|${time}`;
}
/** 置信度数值化, 用于与可配置阈值比较 */
function confRank(c) { return c === 'high' ? 2 : c === 'medium' ? 1 : 0; }

/** 毫秒耗时格式化(回补进度面板用) */
function elapsedFmt(ms) {
  if (!ms || ms < 0) return '0ms';
  if (ms < 1000) return Math.round(ms) + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m${s}s`;
}

export default function Market({ quotes, portfolio }) {
  const [code, setCode] = useState('sz002027');
  const [name, setName] = useState('分众传媒');
  const [period, setPeriod] = useState('day');
  const [sub, setSub] = useState('MACD');
  const [bars, setBars] = useState([]);
  const [ind, setInd] = useState(null);
  const [minute, setMinute] = useState([]);
  const [minuteDate, setMinuteDate] = useState(null); // null = 今日实时; 否则查看已落盘的历史某日
  const [minuteDates, setMinuteDates] = useState([]); // 该股票已落盘的分时日期(降序)
  const [backfillDays, setBackfillDays] = useState(5); // 回补历史交易日数(东财≤5日; 通达信不封顶, 实际深度由服务器数据下限决定)
  const [source, setSource] = useState('tdx'); // 回补数据源: 默认通达信(需启动网关), 可切东财
  const [ibOptions, setIbOptions] = useState([]); // 数据源配置返回的"历史分时回补"可选项(含 maxDays)
  const [backfillStatus, setBackfillStatus] = useState(''); // 回补进度提示
  const [bfProgress, setBfProgress] = useState(null); // 回补实时进度条状态 { active, status, pct, stage, dates, points, ... }
  const pollRef = useRef(null); // 进度轮询定时器
  const [bfMode, setBfMode] = useState('days'); // 回补模式: 'days' 最近N天 | 'range' 日期区间
  const [rangeStart, setRangeStart] = useState(() => { const d = new Date(Date.now() - 7 * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  const [rangeEnd, setRangeEnd] = useState(() => todayLocal());
  const [gap, setGap] = useState(0.96);
  const [winRate, setWinRate] = useState(95.8);
  const [wl, setWl] = useState([]);
  const [idxMode, setIdxMode] = useState('dual'); // 分时主图: 'dual' 价格+振幅%双轴(默认) | 'compare' 叠加大盘指数(涨跌幅%)
  const [cmp, setCmp] = useState(null); // 大盘叠加数据 { index:{name,available}, stock:{prevClose,points:[{t,pct,ipct}]} }
  const [tbMarks, setTbMarks] = useState(null); // 做T分析·分时顶底标记(复用 dotAnalysis.detectTopsBottoms)
  // 分时回放(当日/选中历史日): 原始分时 + 盘后复盘信号(discoveredAt) + 逐根形态概率匹配
  const [replay, setReplay] = useState(null);
  const [minutePreclose, setMinutePreclose] = useState(null); // 分时振幅%基准(昨收): 优先本地日K, 服务端随 /api/minute 返回
  const [rpIndex, setRpIndex] = useState(0);   // 已展示分时根数 0..N
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);        // 0.5/1/2/4 倍速（1× 基准=全天约30秒）
  const rpIndexRef = useRef(0);
  // 回放实时刷新需用 ref 读取最新 playing / replay，避免 15s 定时器闭包拿到旧值
  const playingRef = useRef(false);
  const replayRef = useRef(null);

  // 顶/底信号「差值发送」用 ref(对比上一轮信号列表, 仅发新增, 不做持久化去重)
  const prevTbRef = useRef(new Set());        // 当前查看股 上一轮 tbMarks 的 sigKey 集合
  const prevBgMarksRef = useRef(new Map());   // 后台监控 每只自选股 上一轮 sigKey 集合
  const bgQueueRef = useRef([]);              // 后台待发送信号队列(本轮新出现)
  const notifyMinConfRef = useRef('low');     // 自动推送最低置信度(读企微配置, 默认 low=全部发送)
  const snapshotRef = useRef(null);   // 屏幕上三模块容器(当前标的截图用)
  const bgShotRef = useRef(null);     // 离屏 StockSnapshot 容器(后台自选股截图用)
  const bgBusy = useRef(false);       // 后台截图进行中, 防止并发
  const bgTimeoutRef = useRef(null);  // 看门狗: 截图超时兜底, 避免卡死监控
  const [bgShot, setBgShot] = useState(null); // { code, name, type, price, time } 待离屏截图推送

  // 当前查看的股票单独订阅 WS, 保证任意股票(不仅自选/持仓)都有实时 quote → 决策面板字段不缺失
  const [liveQuote, setLiveQuote] = useState(null);
  useEffect(() => {
    let alive = true;
    const conn = connectQuotes((msg) => {
      if (msg.type === 'quotes' && Array.isArray(msg.data)) {
        const q = msg.data.find((x) => x.code === code);
        if (q && alive) setLiveQuote(q);
      }
    });
    conn.subscribe([code]);
    // REST 兜底: 即便 WS 尚未就绪, 也立即拉一次实时报价, 保证决策面板字段(昨收/换手/振幅)不空白
    api.quote([code]).then((r) => {
      if (alive && r && r.ok && r.data && r.data[0]) setLiveQuote((prev) => prev || r.data[0]);
    }).catch(() => {});
    return () => { alive = false; conn.close(); };
  }, [code]);
  const quote = liveQuote || quotes[code];

  // 同步最新 playing / replay 到 ref，供回放 15s 实时刷新定时器读取（避免闭包旧值）
  useEffect(() => { playingRef.current = playing; }, [playing]);
  useEffect(() => { replayRef.current = replay; }, [replay]);

  useEffect(() => { api.watchlist().then((r) => setWl(r.data || [])); }, []);

  // 读取企微配置中的「自动推送最低置信度」, 供顶/底信号推送门槛使用(默认 high)
  useEffect(() => {
    api.wecomConfig().then((r) => {
      if (r && r.ok && r.data && r.data.notifyMinConfidence) notifyMinConfRef.current = r.data.notifyMinConfidence;
    }).catch(() => {});
  }, []);

  // 历史回补: 默认源跟随「数据源配置」(默认通达信), 并读取各源"可回补交易日上限"(maxDays)
  useEffect(() => {
    api.dataSourceConfig().then((r) => {
      if (r && r.ok && r.config && r.config.intradayBackfill) setSource(r.config.intradayBackfill);
      if (r && r.catalog && r.catalog.intradayBackfill && r.catalog.intradayBackfill.options) {
        setIbOptions(r.catalog.intradayBackfill.options);
      }
    }).catch(() => {});
  }, []);

  // 当前选中源的"可回补交易日上限": 东财=5, 通达信=0(不封顶); 0 或缺省视为无上限
  const rawMaxDays = (ibOptions.find((o) => o.id === source) || {}).maxDays;
  const ibUncapped = rawMaxDays === 0 || (rawMaxDays == null && source === 'tdx');
  const ibMaxDays = ibUncapped ? 0 : (rawMaxDays || 5); // 0 表示不封顶
  // 源切换导致上限变化时, 把已输入的天数收敛进新区间(不封顶源不收敛)
  useEffect(() => {
    if (ibUncapped) { setBackfillDays((d) => Math.max(parseInt(d, 10) || 1, 1)); return; }
    setBackfillDays((d) => Math.min(Math.max(parseInt(d, 10) || 1, 1), ibMaxDays));
  }, [ibMaxDays, ibUncapped]);

  // 拉取该股票已落盘的分时历史日期(供日期选择器)
  useEffect(() => {
    api.intradayDates(code).then((r) => setMinuteDates(r.dates || []));
  }, [code]);

  useEffect(() => {
    let alive = true;
    setMinuteDate(null); // 切换股票回到今日实时
    const limit = period === '5m' ? 960 : 250;
    api.kline(code, period, limit).then((r) => { if (alive) setBars(r.data || []); });
    api.indicators(code, period, ['MA', 'MACD', 'KDJ', 'BOLL'], limit).then((r) => { if (alive) setInd(r.indicators || null); });
    api.minute(code, minuteDate || undefined).then((r) => { if (alive) { setMinute(r.data || []); if (r.preclose) setMinutePreclose(r.preclose); } });
    // 拉该股票做T回测得到 gap / winRate
    api.backtest({ code, strategy: 't0', qty: 2000, variant: 'standard' }).then((r) => {
      if (!alive || !r.ok) return;
      if (r.median_gap_pct) setGap(r.median_gap_pct);
      if (r.metrics) setWinRate(r.metrics.win_rate);
    });
    return () => { alive = false; };
  }, [code, period]);

  // 分时: 今日实时每15s轮询; 选中历史日则一次性拉取已落盘数据(不轮询)
  // 同步加载做T分析·分时顶底标记(复用同一套 detectTopsBottoms 逻辑)
  useEffect(() => {
    let alive = true;
    const loadTB = () => api.dotTopsBottoms(code, minuteDate || undefined)
      .then((r) => { if (alive) setTbMarks(r.ok ? (r.marks || []) : null); })
      .catch(() => { if (alive) setTbMarks(null); });
    if (minuteDate) {
      api.minute(code, minuteDate).then((r) => { if (alive) { setMinute(r.data || []); if (r.preclose) setMinutePreclose(r.preclose); } });
      loadTB();
      return () => { alive = false; };
    }
    const load = () => { api.minute(code).then((r) => { if (alive) setMinute(r.data || []); }); loadTB(); };
    load();
    const t = setInterval(load, 15000);
    return () => { alive = false; clearInterval(t); };
  }, [code, minuteDate]);

  // 大盘指数叠加数据(实时看盘·当日分时板块): 个股 + 其交易所对应大盘指数的分时涨跌幅(%)
  useEffect(() => {
    let alive = true;
    api.intradayCompare(code, minuteDate || undefined)
      .then((r) => { if (alive) setCmp(r && r.ok ? r : null); })
      .catch(() => { if (alive) setCmp(null); });
    return () => { alive = false; };
  }, [code, minuteDate]);

  // 分时回放数据(带形态概率): 默认回放「当日」(minuteDate 为空 → 实时看盘用今天)，选中历史日则回放该日
  // 注意：rd 默认 todayLocal()，不要回退到 minuteDates[0]（最早历史日）—— 换股时 minuteDates 仍是旧股票数据,
  //   会导致回放误抓旧股票的最早历史日(常 ok:false → 形态名称不刷新), 故实时视图恒用今天。
  // 实时视图(minuteDate 为空): 跟随实盘每 15s 刷新回放 —— 回放读取的是「已落盘分时」(主图轮询每分钟也会 saveToday 落盘),
  //   故刷新后信息栏当前价/最高最低/均价/振幅、盘后复盘信号、以及「形态概率匹配」均实时跟随实盘分时图变化；
  //   仅当用户正在回放(播放中或已拖动到非末尾)时保留其进度, 否则把进度推到最新(追平实盘)。历史日不轮询(一次性加载)。
  useEffect(() => {
    let alive = true;
    const rd = minuteDate || todayLocal();
    const isLive = !minuteDate;
    const load = (isRefresh) => {
      api.dotReplay(code, rd, true)
        .then((r) => {
          if (!alive) return;
          if (r.ok) {
            setReplay(r);
            if (!isLive || !isRefresh) {
              // 首次加载 / 切换股票 / 历史日: 直接定位到末尾并停止播放
              setRpIndex(r.count); rpIndexRef.current = r.count; setPlaying(false);
            } else {
              // 实时视图的 15s 刷新: 仅当用户已「追平」(未播放且停在末尾)才把进度推到最新, 否则保留回放位置
              const atEnd = !playingRef.current && rpIndexRef.current >= (replayRef.current ? replayRef.current.count : 0);
              if (atEnd) { setRpIndex(r.count); rpIndexRef.current = r.count; }
            }
          } else setReplay(null);
        })
        .catch(() => { if (alive) setReplay(null); });
    };
    load(false);
    let timer = null;
    if (isLive) timer = setInterval(() => load(true), 15000);
    return () => { alive = false; if (timer) clearInterval(timer); };
  }, [code, minuteDate]);

  // 进度轮询: 每 800ms 拉取一次回补实时进度, 直到终态
  const stopPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  const startPoll = (c) => {
    stopPoll();
    let noProgressTicks = 0;
    const tick = async () => {
      try {
        const r = await api.intradayBackfillProgress(c);
        if (!r || !r.ok || !r.active) {
          // 尚未拿到进度(任务刚提交)或进度已过期 —— 宽容几次后再放弃
          if (++noProgressTicks > 10) {
            stopPoll();
            setBackfillStatus('未能获取回补进度，请检查后端日志');
            setBfProgress(null);
          }
          return;
        }
        noProgressTicks = 0;
        const total = r.totalPages || 1;
        const cur = r.currentPage || 0;
        const pct = Math.max(0, Math.min(100, Math.round((cur / total) * 100)));
        // 耗时 / 速度 / 预计剩余(基于后端上报的 startedAt/updatedAt 与已抓点数)
        const elapsed = (r.updatedAt && r.startedAt) ? Math.max(0, r.updatedAt - r.startedAt) : 0;
        const speed = elapsed > 0 ? (r.points || 0) / (elapsed / 1000) : 0; // 点/秒
        const eta = (pct > 2 && pct < 100) ? Math.round((elapsed / pct) * (100 - pct)) : null;
        setBfProgress({
          active: true, status: r.status, pct, stage: r.stage,
          dates: r.dates, points: r.points,
          currentPage: cur, totalPages: total,
          source: r.source, mode: r.mode, reqDays: r.reqDays,
          skippedExisting: r.skippedExisting, written: r.written,
          startedAt: r.startedAt, updatedAt: r.updatedAt,
          elapsedMs: elapsed, speed: Math.round(speed), etaMs: eta,
          rangeStart: r.rangeStart, rangeEnd: r.rangeEnd,
          reason: r.reason, error: r.error,
        });
        // 终态: 停止轮询并给出结论
        if (r.status === 'done' || r.status === 'degraded' || r.status === 'error') {
          stopPoll();
          if (r.status === 'done') {
            const skip = r.skippedExisting ? `，跳过本地已有 ${r.skippedExisting} 天` : '';
            const extra = r.rangeCapped ? `；⚠️ 起始日超出可回补深度，最早仅到 ${r.rangeCapped}` : '';
            if (r.upToDate) {
              setBackfillStatus(`本地已是最新，无需回补${skip}`);
            } else {
              setBackfillStatus(`已回补 ${r.written} 天 / ${r.points} 点${skip}${extra}`);
            }
            const rd = await api.intradayDates(c);
            setMinuteDates(rd.dates || []);
          } else if (r.status === 'degraded') {
            setBackfillStatus('⚠️ ' + (r.reason || '该数据源暂不可用，建议由 agent 手动回补'));
          } else {
            setBackfillStatus('回补失败: ' + (r.error || '未知'));
          }
          setBfProgress(null);
        }
      } catch (e) {
        stopPoll();
        setBackfillStatus('回补进度异常: ' + e.message);
        setBfProgress(null);
      }
    };
    tick();
    pollRef.current = setInterval(tick, 800);
  };

  // 从历史接口回补分时并落盘; POST 立即返回, 之后轮询进度条(支持东财/通daxin; 最近N天 或 指定日期区间)
  const handleBackfill = async () => {
    setBackfillStatus('');
    setBfProgress({ active: true, status: 'starting', pct: 0, stage: '提交回补任务…' });
    try {
      const range = bfMode === 'range' ? { start: rangeStart, end: rangeEnd } : null;
      const r = await api.intradayBackfill(code, backfillDays, source, range);
      if (r && r.skipped) {
        setBackfillStatus('回补进行中，请稍候');
        startPoll(code); // 已有任务在跑, 继续轮询其进度
        return;
      }
      if (!r || !r.started) {
        setBackfillStatus('未能启动回补: ' + ((r && (r.error || r.reason)) || '未知'));
        setBfProgress(null);
        return;
      }
      startPoll(code);
    } catch (e) {
      setBackfillStatus('回补请求异常: ' + e.message);
      setBfProgress(null);
    }
  };

  // 组件卸载时清理轮询定时器与后台监控看门狗
  useEffect(() => () => { stopPoll(); if (bgTimeoutRef.current) { clearTimeout(bgTimeoutRef.current); bgTimeoutRef.current = null; } }, []);

  // 5分钟K线盘中自动刷新(含副图指标): 让当日新生成的5分钟BAR与MACD/KDJ等实时更新
  // (分时图本身由上面的分时轮询驱动, 此处只刷新K线及其指标)
  useEffect(() => {
    if (period !== '5m') return;
    const limit = 960;
    const tick = () => {
      api.kline(code, '5m', limit).then((r) => { if (r.ok && r.data) setBars(r.data); });
      api.indicators(code, '5m', ['MA', 'MACD', 'KDJ', 'BOLL'], limit).then((r) => { if (r.ok && r.indicators) setInd(r.indicators); });
    };
    const t = setInterval(tick, 15000);
    return () => clearInterval(t);
  }, [code, period]);

  // 换股时立即清空旧回放/形态态，避免旧股票形态名称在实时视图中短暂残留(新回放回来前不再显示旧名)；
  // 同时把历史回看日期重置为「今日实时」，否则旧股票选中的历史日会连带带回放到新股票(常无数据→形态名不刷新)
  const pick = (c, n) => { setCode(c); setName(n); setMinuteDate(null); setReplay(null); setRpIndex(0); setPlaying(false); };

  // 实时 quote 的最新引用(避免信号 effect 因每3s推送而频繁重跑)
  const quoteRef = useRef(quote);
  useEffect(() => { quoteRef.current = quote; }, [quote]);

  // 图表实例引用(用于信号截图)
  const minuteChartRef = useRef(null);
  const klineChartRef = useRef(null);

  // 仅当数据(bars/ind/sub/minute)真正变化时重建 option, 避免实时推送/分时轮询触发重渲染
  // 把 dataZoom 用户缩放状态被 setOption(notMerge) 重置
  // fullDates: 实时看盘K线底部日期轴按可视范围计算合理间隔, 显示更完整(不过疏/重叠/裁切)
  const kOpt = useMemo(() => klineOption(bars, ind, sub, { fullDates: true }), [bars, ind, sub]);
  // 分时图下方副图: 通达信日内T指标 (数据变化时重算)
  const intra = useMemo(() => (minute.length ? computeIntradayT(minute) : null), [minute]);
  // 当日成交均价(VWAP): 取最新分时根 avg, 供右侧决策面板展示(实时跟随)
  const intradayAvg = useMemo(() => (minute.length ? minute[minute.length - 1].avg : null), [minute]);
  // 实时 quote 的昨收(今日双轴振幅%基准)：优先 preclose(腾讯行情字段), 否则由 price/change_pct 反推
  const livePrevClose = useMemo(() => {
    if (!quote) return null;
    if (quote.preclose) return Number(quote.preclose);
    if (quote.prev_close) return Number(quote.prev_close);
    if (quote.price != null && quote.change_pct != null) return +(quote.price / (1 + Number(quote.change_pct) / 100)).toFixed(2);
    return null;
  }, [quote]);

  // ---------- 分时回放：播放控制 + 盘中顶底信号 vs 盘后复盘 + 逐根形态概率匹配 ----------
  const N = replay ? replay.count : 0;
  const replayDelay = N ? 30000 / N / speed : 200; // 默认 1×：全天约 30 秒回放完
  useEffect(() => {
    if (!playing) return;
    if (rpIndexRef.current >= N) { setPlaying(false); return; }
    const id = setTimeout(() => {
      const next = rpIndexRef.current + 1;
      rpIndexRef.current = next;
      setRpIndex(next);
      if (next >= N) setPlaying(false);
    }, replayDelay);
    return () => clearTimeout(id);
  }, [playing, rpIndex, speed, N, replayDelay]);

  const finalSignals = replay ? replay.signals : [];
  const inPlay = finalSignals.filter((s) => s.discoveredAt <= rpIndex); // 盘中已发出
  const committed = inPlay.filter((s) => finalSignals.some((f) => f.type === s.type && f.index === s.index)); // 与盘后一致(已提交)
  const tentative = inPlay.filter((s) => !finalSignals.some((f) => f.type === s.type && f.index === s.index)); // 盘尾未定型极值
  const total = finalSignals.length;
  const curTime = rpIndex > 0 && replay ? replay.rows[rpIndex - 1].t : '';
  const allMatched = rpIndex >= N && total > 0 && committed.length === total;
  const curPattern = (replay && replay.patternProbs && rpIndex > 0) ? replay.patternProbs[rpIndex - 1] : null;

  // 回放是否接管主图：仅当真正在回放(已步进/播放)时接管，否则主图显示完整分时(可切换叠加大盘)
  const replaying = !!(replay && (playing || rpIndex < N));
  // 主图显示数据：回放中按进度切片(逐步揭示)，否则显示完整分时
  const dispData = replaying ? replay.rows.slice(0, rpIndex) : minute;
  // 双轴振幅%基准(昨收)：统一以「该显示日的真实昨收」为准
  //  - 优先用回放接口返回的 replay.prevClose(来自日K前一交易日收盘，最权威)
  // 振幅%基准(昨收)：优先用 /api/minute 随分时返回的「上一交易日原始分时末价」(raw, 与当日分时同尺度,
  //   避免日K前复权/除权除息导致的尺度错配, 7月9日之前也准确)；其次回放接口的真实昨收(同为 raw)；
  //   再次实时 quote.preclose(今日 raw)；最后回退开盘价(振幅≈0, 不虚高)。绝不用今日 quote 兜底历史日。
  const viewingDate = minuteDate || todayLocal();
  const replayCoversDay = !!(replay && replay.prevClose && replay.date === viewingDate);
  const dispPrevClose = (minutePreclose && minutePreclose > 0)
    ? minutePreclose
    : (replayCoversDay
        ? replay.prevClose
        : (livePrevClose || (minute.length ? minute[0].price : undefined)));
  const dispTb = replaying ? inPlay.map((s) => ({ type: s.type, time: s.time, price: s.price, dev: s.dev })) : tbMarks;
  const dispIntra = useMemo(() => (dispData.length ? computeIntradayT(dispData) : null), [dispData]);

  // 分时主图:
  //  - 回放中：始终用双轴(价格+振幅%)，在「当日分时」同一位置逐步揭示顶底与形态概率
  //  - 静态(未回放)：'compare' 叠加大盘指数(涨跌幅% · 0为中心) | 'dual' 价格+振幅%双轴(默认)
  const mOpt = useMemo(() => {
    if (replaying) {
      return minuteDualAxisOption(dispData, dispIntra, { topsBottoms: dispTb, prevClose: dispPrevClose });
    }
    if (idxMode === 'compare' && cmp && cmp.stock && cmp.stock.points && cmp.stock.points.length) {
      return minuteOption(minute, intra, { cmp, topsBottoms: tbMarks });
    }
    return minuteDualAxisOption(minute, intra, { topsBottoms: tbMarks, prevClose: dispPrevClose });
  }, [replaying, dispData, dispIntra, minute, intra, idxMode, cmp, tbMarks, dispTb, dispPrevClose]);

  // 当日分时「做T顶底」信号(图中可见的顶/底标记) -> 企微通知(带三模块一张截图)
  // 触发条件 = 图中 tbMarks(高置信顶/底)，与「做T分析」同一套 detectTopsBottoms；
  // 推送时截图屏幕上「当日分时 + 做T决策面板 + 当前分时形态概率匹配」三模块为单张图随通知发送。
  // 去重: code|本地日期|type|信号时间, 同步 localStorage(防刷新重复) + 与服务端 notify_log 统一。
  // 当日分时「做T顶底」信号(图中可见的顶/底标记) -> 企微通知(带三模块一张截图)
  // 差值发送: 仅发「本轮新增」的信号(对比上一轮 tbMarks), 不做持久化去重 -> 每次真实出现都发, 数量不限。
  useEffect(() => {
    if (minuteDate) return; // 仅今日实时分时触发, 历史回看不推送
    if (!tbMarks || !tbMarks.length) { prevTbRef.current = new Set(); return; }
    const lastBar = minute[minute.length - 1];
    const nowSet = new Set();
    const added = [];
    for (const m of tbMarks) {
      if (confRank(m.confidence) < confRank(notifyMinConfRef.current)) continue; // 低于配置阈值不推送
      const key = sigKeyOf(code, m.type, m.time);
      nowSet.add(key);
      if (prevTbRef.current.has(key)) continue; // 非新增 -> 跳过(差值发送)
      added.push(m);
    }
    prevTbRef.current = nowSet;
    for (const m of added) {
      const payload = {
        type: m.type, code, name: quoteRef.current?.name || name,
        price: m.price,
        avg: (lastBar && lastBar.avg != null) ? lastBar.avg : m.price,
        time: m.time,
        confidence: m.confidence, dev: m.dev, divergence: m.divergence, volRatio: m.volRatio,
      };
      if (snapshotRef.current) {
        html2canvas(snapshotRef.current, { backgroundColor: '#fff', pixelRatio: 1.5, scale: 1.5, logging: false })
          .then((canvas) => api.notify({ ...payload, images: [canvas.toDataURL('image/png')] }))
          .catch(() => api.notify(payload));
      } else {
        api.notify(payload);
      }
    }
  }, [tbMarks, code, minuteDate]);

  // 后台队列处理器: 从 bgQueueRef 取一个信号, 渲染 StockSnapshot 截图并推送, 完成后自动处理下一个。
  const bgProcess = useCallback(() => {
    if (bgBusy.current) return;
    const next = bgQueueRef.current.shift();
    if (!next) { setBgShot(null); return; }
    bgBusy.current = true;
    if (bgTimeoutRef.current) clearTimeout(bgTimeoutRef.current);
    bgTimeoutRef.current = setTimeout(() => {
      bgTimeoutRef.current = null;
      bgBusy.current = false;
      bgQueueRef.current = [];
      setBgShot(null);
    }, 12000);
    setBgShot(next);
  }, []);

  // 后台自选股监控: 对「当前未查看」的自选股定时扫描顶/底, 命中新信号后在离屏容器挂载 StockSnapshot 截图推送。
  // 默认全量自选股纳入监控(无需额外配置)。差值发送: 每轮只发「本轮新出现」信号, 不做持久化去重, 数量不限。
  useEffect(() => {
    let cancelled = false;
    const scan = async () => {
      if (cancelled) return;
      let list = [];
      try { const r = await api.watchlist(); list = (r && r.data) || []; } catch (_) { return; }
      for (const w of list) {
        if (cancelled) return;
        if (w.code === code) continue; // 当前查看标的由屏幕推送负责
        try {
          const r = await api.dotTopsBottoms(w.code);
          const marks = (r && r.ok && r.marks) || [];
          const prevSet = prevBgMarksRef.current.get(w.code) || new Set();
          const nowSet = new Set();
          for (const m of marks) {
            if (confRank(m.confidence) < confRank(notifyMinConfRef.current)) continue;
            const key = sigKeyOf(w.code, m.type, m.time);
            nowSet.add(key);
            if (prevSet.has(key)) continue; // 非本轮新增 -> 跳过(差值发送)
            bgQueueRef.current.push({ code: w.code, name: w.name, type: m.type, price: m.price, time: m.time, confidence: m.confidence, dev: m.dev, divergence: m.divergence, volRatio: m.volRatio });
          }
          prevBgMarksRef.current.set(w.code, nowSet);
        } catch (_) { /* 单只异常忽略, 不影响其他 */ }
      }
      bgProcess(); // 启动队列处理(若空闲则开始发送本轮新信号)
    };
    const timer = setInterval(scan, 30000); // 每 30 秒扫一轮(按你要求: 每轮每只触发股都发一次, 无数量限制)
    scan();
    return () => { cancelled = true; clearInterval(timer); };
  }, [code, bgProcess]);

  return (
    <div>
      <div className="panel">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input value={code} onChange={(e) => setCode(normCode(e.target.value.trim()))} style={{ width: 120 }} placeholder="代码如 000001" />
          <span style={{ fontWeight: 700 }}>{quote?.name || name}</span>
          {quote && <>
            <span className={'bigprice ' + fmt.cls(quote.change_pct)} style={{ fontSize: 24 }}>{fmt.price(quote.price)}</span>
            <span className={fmt.cls(quote.change_pct)}>{fmt.pct(quote.change_pct)}</span>
            <span className="muted">高 {fmt.price(quote.high)} 低 {fmt.price(quote.low)} 量 {(quote.volume/10000).toFixed(1)}万手</span>
          </>}
          <span style={{ marginLeft: 'auto' }} className="muted">自选快切：</span>
          {wl.map((w) => <button key={w.code} className="btn" onClick={() => pick(w.code, w.name)} style={{ padding: '4px 8px' }}>{w.name}</button>)}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* 当日分时(左·66%) 与 右侧(决策面板+分时回放)(右·34%) 并排布局 */}
        <div className="watch-row" ref={snapshotRef}>
          <div className="panel col-left">
            <h3>📉 当日分时 <span className="pill">15s 刷新</span>
            <select value={idxMode} onChange={(e) => setIdxMode(e.target.value)} disabled={replaying}
              title={replaying ? '回放中已固定为「价格+振幅%」双轴视图' : ''}
              style={{ marginLeft: 10, fontSize: 13, padding: '2px 6px', opacity: replaying ? 0.5 : 1 }}>
              <option value="dual">价格+振幅%</option>
              <option value="compare">{cmp?.index?.name ? '叠加大盘·' + cmp.index.name : '叠加大盘指数'}</option>
            </select>
            {replaying && <span className="pill" style={{ marginLeft: 6 }}>回放中(主图=分时回放)</span>}
            {idxMode === 'compare' && cmp?.index?.available === false && <span className="pill" style={{ marginLeft: 6 }}>大盘仅实时可叠加</span>}
            <select value={minuteDate || ''} onChange={(e) => setMinuteDate(e.target.value || null)}
              style={{ marginLeft: 10, fontSize: 13, padding: '2px 6px' }}>
              <option value="">今日实时</option>
              {minuteDates.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            {minuteDate && <span className="pill" style={{ marginLeft: 6 }}>已落盘回看</span>}
          </h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0 8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, color: '#888' }}>历史回补:</span>
            <select value={source} onChange={(e) => setSource(e.target.value)}
              style={{ fontSize: 13, padding: '2px 6px' }}>
              <option value="tdx">通达信(深·需启动网关)</option>
              <option value="eastmoney">东财(免费·约5日)</option>
            </select>
            <select value={bfMode} onChange={(e) => setBfMode(e.target.value)} style={{ fontSize: 13, padding: '2px 6px' }}>
              <option value="days">最近N天</option>
              <option value="range">日期区间</option>
            </select>
            {bfMode === 'days' ? (
              <>
                <input type="number" min={1} max={ibUncapped ? undefined : ibMaxDays} value={backfillDays}
                  onChange={(e) => {
                    const v = Math.max(parseInt(e.target.value || '5', 10), 1);
                    setBackfillDays(ibUncapped ? v : Math.min(v, ibMaxDays));
                  }}
                  style={{ width: 56, padding: '2px 6px', fontSize: 13 }} />
                <span style={{ fontSize: 13, color: '#888' }}>
                  {ibUncapped ? '个交易日 (不封顶·仅回补本地缺失)' : `个交易日 (≤${ibMaxDays})`}
                </span>
              </>
            ) : (
              <>
                <input type="date" value={rangeStart} max={rangeEnd}
                  onChange={(e) => setRangeStart(e.target.value)} style={{ fontSize: 13, padding: '2px 6px' }} />
                <span style={{ fontSize: 13, color: '#888' }}>至</span>
                <input type="date" value={rangeEnd} max={todayLocal()}
                  onChange={(e) => setRangeEnd(e.target.value)} style={{ fontSize: 13, padding: '2px 6px' }} />
                <span style={{ fontSize: 12, color: source === 'tdx' ? '#0a8' : '#c60' }}>
                  {source === 'tdx' ? '通达信不封顶·仅回补本地缺失日期' : '东财仅截至今日≤5日'}
                </span>
              </>
            )}
            <button onClick={handleBackfill} style={{ padding: '3px 10px', fontSize: 13, cursor: 'pointer' }}>
              {source === 'tdx' ? '从通达信回补' : '从东财回补'}
            </button>
            {backfillStatus && <span style={{ fontSize: 12, color: '#0a8' }}>{backfillStatus}</span>}
          </div>
          {bfProgress && bfProgress.active && (
            <div style={{ marginTop: 4, marginBottom: 8, border: '1px solid #e3e6ea', borderRadius: 8, padding: '8px 10px', background: '#fafbfc' }}>
              {/* 头部: 状态 + 阶段 */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: bfProgress.status === 'done' ? '#0a8' : (bfProgress.status === 'degraded' || bfProgress.status === 'error') ? '#e5533c' : '#2b8ee6' }}>
                  {bfProgress.status === 'done' ? '✅ 回补完成'
                    : bfProgress.status === 'degraded' ? '⚠️ 数据源降级'
                    : bfProgress.status === 'error' ? '❌ 回补失败'
                    : '🔄 回补中… ' + (bfProgress.pct || 0) + '%'}
                </span>
                {bfProgress.stage ? <span style={{ fontSize: 12, color: '#666' }}>{bfProgress.stage}</span> : null}
              </div>
              {/* 进度条 */}
              <div style={{ height: 8, background: '#e9ecef', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{
                  height: '100%',
                  width: `${bfProgress.pct || 0}%`,
                  background: bfProgress.status === 'done' ? '#0a8'
                    : (bfProgress.status === 'degraded' || bfProgress.status === 'error') ? '#e5533c'
                    : '#2b8ee6',
                  transition: 'width .35s ease',
                }} />
              </div>
              {/* 详细指标网格 */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '3px 16px', marginTop: 6, fontSize: 12, color: '#555' }}>
                <span>📅 已抓取：<b>{(bfProgress.dates || 0)}</b> 天 / <b>{(bfProgress.points || 0)}</b> 点</span>
                <span>📄 分页：<b>{bfProgress.currentPage || 0}</b> / {bfProgress.totalPages || 1}</span>
                <span>🔌 数据源：{bfProgress.source === 'tdx' ? '通达信' : '东财'}{bfProgress.mode === 'range' ? '（区间）' : '（最近N天）'}</span>
                <span>🎯 请求：{bfProgress.reqDays != null ? bfProgress.reqDays : '—'} 个交易日</span>
                <span>⏱ 已耗时：{elapsedFmt(bfProgress.elapsedMs)}</span>
                <span>⚡ 速度：{(bfProgress.speed != null ? bfProgress.speed : 0)} 点/秒{bfProgress.etaMs ? ' · 预计剩 ' + (bfProgress.etaMs / 1000).toFixed(0) + 's' : ''}</span>
                {bfProgress.rangeStart ? <span>🗓 区间：{bfProgress.rangeStart} ~ {bfProgress.rangeEnd}</span> : <span />}
                {bfProgress.skippedExisting ? <span>⏭ 跳过本地已有：{bfProgress.skippedExisting} 天</span> : <span />}
              </div>
              {(bfProgress.status === 'degraded' || bfProgress.status === 'error') && (
                <div style={{ marginTop: 5, fontSize: 12, color: '#e5533c' }}>
                  {bfProgress.reason || bfProgress.error || '未知错误'}
          </div>
        )}
        </div>
          )}
          {minute.length ? <Chart option={mOpt} height={640} instanceRef={minuteChartRef} /> : <div className="loading">暂无分时数据</div>}
          {/* 做T分析·分时顶底摘要（复用 detectTopsBottoms，与「做T分析」页同一套逻辑） */}
          {tbMarks && tbMarks.length > 0 && (
            <div style={{ marginTop: 8, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', fontSize: 12 }}>
              <span className="pill" style={{ borderColor: '#2f6fed', color: '#2f6fed' }}>🎯 做T顶底（与「做T分析」同一检测）</span>
              <span>共 {tbMarks.length} 个</span>
              <span style={{ color: '#e23c3c' }}>🔻 顶 {tbMarks.filter((m) => m.type === 'top').length}</span>
              <span style={{ color: '#1aa260' }}>🔺 底 {tbMarks.filter((m) => m.type === 'bottom').length}</span>
              {(() => {
                const tops = tbMarks.filter((m) => m.type === 'top');
                const bots = tbMarks.filter((m) => m.type === 'bottom');
                const lastTop = tops.length ? tops[tops.length - 1] : null;
                const lastBot = bots.length ? bots[bots.length - 1] : null;
                const cl = (c) => (c === 'high' ? '高' : c === 'medium' ? '中' : '低');
                return (
                  <>
                    {lastBot && <span className="muted">最近底 {lastBot.time} {lastBot.price}（{cl(lastBot.confidence)}·乖离{lastBot.dev}%）</span>}
                    {lastTop && <span className="muted">最近顶 {lastTop.time} {lastTop.price}（{cl(lastTop.confidence)}·乖离{lastTop.dev}%）</span>}
                  </>
                );
              })()}
              <span className="muted">高置信顶/底盘中有信号时自动推送企微</span>
            </div>
          )}
        </div>
        {/* 右侧列: 决策面板(上) + 分时回放(下) */}
        <div className="col-right">
          <TTDecisionPanel quote={quote} avg={intradayAvg} gapPct={gap} winRate={winRate} minute={minute} minutePreclose={minutePreclose} replayPrevClose={replay && replay.prevClose} />
          {replay && (
            <div className="panel" style={{ minWidth: 0 }}>
            <h3>🎬 分时回放 <span className="pill">盘中信号 vs 盘后复盘</span></h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
              <button className="btn" onClick={() => { setRpIndex(0); rpIndexRef.current = 0; setPlaying(false); }} style={{ padding: '3px 8px' }}>⏮ 重置</button>
              <button className="btn" onClick={() => { if (rpIndexRef.current > 1) { const p = rpIndexRef.current - 1; rpIndexRef.current = p; setRpIndex(p); setPlaying(false); } }} style={{ padding: '3px 8px' }}>◀ 上一根</button>
              <button className="btn" onClick={() => { if (rpIndexRef.current >= N) { setRpIndex(0); rpIndexRef.current = 0; } setPlaying((v) => !v); }} style={{ padding: '3px 8px', fontWeight: 700 }}>{playing ? '⏸ 暂停' : '▶ 播放'}</button>
              <button className="btn" onClick={() => { if (rpIndexRef.current < N) { const p = rpIndexRef.current + 1; rpIndexRef.current = p; setRpIndex(p); setPlaying(false); } }} style={{ padding: '3px 8px' }}>下一根 ▶</button>
              <span className="muted" style={{ fontSize: 12 }}>{curTime || '—'} · {rpIndex}/{N}</span>
              <span style={{ marginLeft: 'auto', fontSize: 12 }} className="muted">速率</span>
              {[0.5, 1, 2, 4].map((sp) => (
                <button key={sp} className="btn" onClick={() => setSpeed(sp)} style={{ padding: '2px 8px', fontWeight: speed === sp ? 700 : 400, background: speed === sp ? '#2f6fed' : '#fff', color: speed === sp ? '#fff' : '#333', border: '1px solid ' + (speed === sp ? '#2f6fed' : '#e3e6ea') }}>{sp}×</button>
              ))}
            </div>
            <input type="range" min={0} max={N} value={rpIndex} onChange={(e) => { const v = Number(e.target.value); rpIndexRef.current = v; setRpIndex(v); setPlaying(false); }} style={{ width: '100%', marginBottom: 8 }} />
            <div style={{ marginTop: 8, fontSize: 12 }}>
              {allMatched
                ? <b style={{ color: '#1e8e3e' }}>✅ 回放至收盘：盘中已提交顶底信号与盘后复盘完全一致（{committed.length}/{total}），算法对已确认信号零撤回。</b>
                : <span className="muted">⏳ 回放进行中… 已提交 {committed.length} / 全天 {total}（含 {tentative.length} 个未定型极值，将在反转确认后定型或随新高/新低平移）。</span>}
            </div>
          </div>
        )}
        {/* 当前分时形态概率匹配(右栏·分时回放下方): 左=唯一最佳匹配率大读数, 右=各形态实时匹配概率分布(合计≈100%, 与左侧同数据源, 不再重复/不一致) */}
        {replay && (
          <div className="panel" style={{ minWidth: 0 }}>
            <h3>🧩 当前分时形态概率匹配 <span className="pill">盘中实时</span></h3>
            <div className="muted" style={{ fontSize: 12, margin: '0 0 8px' }}>左：当前最佳匹配率（唯一）。右：各形态实时匹配概率分布（合计≈100%），蓝色为最佳匹配。</div>
            {curPattern ? (
              (() => {
                const probs = curPattern.probs || [];
                const best = probs.length ? probs.reduce((a, b) => (b.prob > a.prob ? b : a), probs[0]) : null;
                const bestPat = best ? (replay.patterns || []).find((c) => c.id === best.id) : null;
                const bestName = bestPat ? bestPat.name : (curPattern.bestName || '—');
                const bestProb = best ? best.prob : (curPattern.bestProb || 0);
                return (
                  <div style={{ display: 'flex', gap: 14, alignItems: 'stretch' }}>
                    {/* 左侧: 唯一匹配率大读数(实时最佳匹配概率) */}
                    <div style={{ flex: '0 0 140px', display: 'flex', flexDirection: 'column', justifyContent: 'center', borderRight: '1px solid #e3e6ea', paddingRight: 14 }}>
                      <div style={{ fontSize: 12, color: '#6b7280' }}>最佳匹配 · 实时匹配率</div>
                      <div style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.3, marginTop: 2 }}>{bestName}</div>
                      <div style={{ fontSize: 30, fontWeight: 800, color: '#2f6fed', lineHeight: 1.1, marginTop: 4 }}>{(bestProb * 100).toFixed(1)}%</div>
                    </div>
                    {/* 右侧: 各形态实时匹配概率分布(柱状, 与左侧同数据源) */}
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
                      {(replay.patterns || []).map((c) => {
                        const p = (probs.find((x) => x.id === c.id) || {}).prob || 0;
                        const isBest = best && c.id === best.id;
                        return (
                          <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                            <span style={{ flex: '0 0 168px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={c.name + ' ' + (p * 100).toFixed(1) + '%'}>{c.name} <b style={{ fontWeight: 700 }}>{(p * 100).toFixed(1)}%</b></span>
                            <div style={{ flex: 1, height: 10, background: '#eef1f5', borderRadius: 5, overflow: 'hidden' }}>
                              <div style={{ height: '100%', width: (p * 100).toFixed(1) + '%', background: isBest ? '#2f6fed' : '#9bbcf3' }} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()
            ) : (
              <div className="muted">回放加载中…</div>
            )}
          </div>
        )}
        </div>
      </div>
        <div className="panel" style={{ minWidth: 0 }}>
          <h3>🕯 K线
            <select value={period} onChange={(e) => setPeriod(e.target.value)} style={{ marginLeft: 8 }}>
              <option value="5m">5分钟</option><option value="day">日线</option>
            </select>
            <select value={sub} onChange={(e) => setSub(e.target.value)} style={{ marginLeft: 6 }}>
              <option value="MACD">MACD</option><option value="KDJ">KDJ</option><option value="BOLL">BOLL叠加</option>
            </select>
          </h3>
          {bars.length ? <Chart option={kOpt} height={340} instanceRef={klineChartRef} /> : <div className="loading">加载K线…</div>}
        </div>
      </div>
      {/* 离屏后台监控: 命中非当前查看自选股的高置信顶/底时, 挂载 StockSnapshot 截图推送 */}
      {bgShot && (
        <div style={{ position: 'fixed', left: -10000, top: 0, width: 1000, zIndex: -1, background: '#fff' }}>
          <StockSnapshot
            ref={bgShotRef}
            code={bgShot.code}
            name={bgShot.name}
            signal={bgShot}
            onReady={() => {
              // onReady 已触发 → 取消看门狗(避免截图耗时过长误触发; 看门狗仅兜底 onReady 永不触发)
              if (bgTimeoutRef.current) { clearTimeout(bgTimeoutRef.current); bgTimeoutRef.current = null; }
              // 等待图表/面板渲染稳定后截图
              setTimeout(async () => {
                const el = bgShotRef.current;
                const payload = { type: bgShot.type, code: bgShot.code, name: bgShot.name, price: bgShot.price, time: bgShot.time, confidence: bgShot.confidence, dev: bgShot.dev, divergence: bgShot.divergence, volRatio: bgShot.volRatio };
                try {
                  if (el) {
                    const canvas = await html2canvas(el, { backgroundColor: '#fff', pixelRatio: 1.5, scale: 1.5, logging: false });
                    await api.notify({ ...payload, images: [canvas.toDataURL('image/png')] });
                  } else {
                    await api.notify(payload);
                  }
                } catch (_) {
                  await api.notify(payload); // 截图失败仍发文字
                } finally {
                  bgBusy.current = false;
                  bgProcess(); // 处理队列中下一个信号(空则归位)
                }
              }, 500);
            }}
          />
        </div>
      )}
    </div>
  );
}
