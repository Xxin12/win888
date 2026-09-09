import React, { useEffect, useRef, useState, useMemo } from 'react';
import { api, fmt } from '../api';

const PAGE_SIZE = 50;
const TYPE_LABEL = { intraday: '分时行情', '5min': '5分钟行情', day: '日线行情' };

export default function Quotes({ quotes, portfolio }) {
  const [stocks, setStocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [listSource, setListSource] = useState('');
  const [q, setQ] = useState('');
  const [market, setMarket] = useState('all');
  const [page, setPage] = useState(1);
  const [allCoverage, setAllCoverage] = useState({}); // 全市场本地数据覆盖(用于"无本地数据"筛选 + 已有/缺失标记)
  const [jobs, setJobs] = useState([]);
  const [queue, setQueue] = useState([]); // 待执行回补队列(不含正在跑的), 用于"排队中"横幅
  const [notice, setNotice] = useState(''); // 触发回补后的轻提示(已加入队列/排第几位)
  const [force, setForce] = useState(false);
  const [hideDelisted, setHideDelisted] = useState(false); // 隐藏已退市股票
  const [industryFilter, setIndustryFilter] = useState('all'); // 行业板块筛选(全部/未分类/具体行业)
  const [view, setView] = useState('stock'); // 'stock'(A股全市场) | 'index'(大盘指数) —— 行情中心两大分类
  const [indicesAll, setIndicesAll] = useState([]); // 大盘指数全部代码(供"回补全部指数"用)
  // 本地数据存在性筛选(分时 / 5分钟 / 日线, 各自 全部/有数据/无数据)
  const [covIntraday, setCovIntraday] = useState('all');
  const [cov5min, setCov5min] = useState('all');
  const [covDay, setCovDay] = useState('all');
  const [refreshing, setRefreshing] = useState(false);
  const intervalRef = useRef(null);
  const autoCloseRef = useRef(null); // 全部完成后自动关闭计时器(与看盘页回补进度一致)
  const dismissedRef = useRef(new Set()); // 已自动关闭/手动关闭的回补类型, 轮询不再"复活"
  const refreshedTypesRef = useRef(new Set()); // 已为哪些回补类型在完成后刷新过覆盖(防重复刷新)
  const [covVersion, setCovVersion] = useState(0); // 回补完成后自增, 强制重新拉取当前展示股票的覆盖(标准: 获取后更新展示数据)
  const [lastResults, setLastResults] = useState([]); // 最近回补结果汇总(按类型持久, 刷新不丢)
  const [logs, setLogs] = useState([]); // 执行日志(后端持久, 刷新不丢)
  const [showLog, setShowLog] = useState(false); // 执行日志面板展开/收起
  // 分时历史回补选项(与实时看盘页历史回补一致): 数据源 + 模式(最近N天/日期区间) + 天数 + 区间
  const [bfSource, setBfSource] = useState('tdx');          // 分时回补数据源(默认通达信, 跟随数据源配置)
  const [bfOptions, setBfOptions] = useState([]);           // 数据源配置返回的"历史分时回补"可选项(含 maxDays)
  const [bfMode, setBfMode] = useState('days');             // 'days' 最近N天 | 'range' 日期区间
  const [bfDays, setBfDays] = useState(5000);               // 回补交易日数(5000=全量历史哨兵; 东财≤5, 通达信不封顶)
  const [bfRangeStart, setBfRangeStart] = useState(() => { const d = new Date(Date.now() - 30 * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  const [bfRangeEnd, setBfRangeEnd] = useState(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  // 本地今日 YYYY-MM-DD(日期区间 max 约束)
  const todayLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

  // ---- 加载列表(按 view 切换 A股 / 大盘指数) ----
  const loadStocks = async (forceRefresh) => {
    setLoading(true);
    setListError('');
    try {
      if (view === 'index') {
        // 大盘指数: 独立静态清单(不进 A股股票池), 自带覆盖信息直接注入
        const r = await api.indices();
        if (r.ok && r.indices) {
          setStocks(r.indices);
          setIndicesAll(r.indices.map((x) => x.code));
          const cov = {};
          for (const s of r.indices) cov[s.code] = { has5min: s.has5min, hasDay: s.hasDay, intradayDates: s.intradayDates };
          setAllCoverage(cov);
        } else setStocks([]);
        setListSource('indices');
        if (r.error && (!r.indices || r.indices.length === 0)) setListError(r.error);
      } else {
        const r = forceRefresh ? await api.stocksRefresh() : await api.stocks();
        if (r.ok && r.stocks) setStocks(r.stocks);
        else setStocks([]);
        if (r.source) setListSource(r.source);
        // 仅当真正无数据时把降级/错误说明显示为错误; 有数据(如已回退本地快照/腾讯探测)不误报
        if (r.error && (!r.stocks || r.stocks.length === 0)) setListError(r.error);
      }
    } catch (e) {
      setListError((view === 'index' ? '加载指数列表失败：' : '加载股票列表失败：') + e.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { loadStocks(false); }, [view]); // 切换分类(A股/指数)即重载列表

  // 分时历史回补: 默认源跟随「数据源配置」(默认通达信), 并读取各源"可回补交易日上限"(maxDays)
  useEffect(() => {
    api.dataSourceConfig().then((r) => {
      if (r && r.ok && r.config && r.config.intradayBackfill) setBfSource(r.config.intradayBackfill);
      if (r && r.catalog && r.catalog.intradayBackfill && r.catalog.intradayBackfill.options) {
        setBfOptions(r.catalog.intradayBackfill.options);
      }
    }).catch(() => {});
  }, []);

  // 当前选中源的"可回补交易日上限": 东财=5, 通达信=0(不封顶); 0 或缺省视为无上限
  const rawMaxDays = (bfOptions.find((o) => o.id === bfSource) || {}).maxDays;
  const ibUncapped = rawMaxDays === 0 || (rawMaxDays == null && bfSource === 'tdx');
  const ibMaxDays = ibUncapped ? 0 : (rawMaxDays || 5); // 0 表示不封顶
  // 源切换导致上限变化时, 把已输入的天数收敛进新区间(不封顶源不收敛)
  useEffect(() => {
    if (ibUncapped) { setBfDays((d) => Math.max(parseInt(d, 10) || 1, 1)); return; }
    setBfDays((d) => Math.min(Math.max(parseInt(d, 10) || 1, 1), ibMaxDays));
  }, [ibMaxDays, ibUncapped]);

  // ---- 过滤 + 分页 ----
  // 行业选项: 从全量列表去重(按中文排序), 供筛选下拉
  const industryOptions = useMemo(() => {
    const set = new Set();
    for (const s of stocks) if (s.industry) set.add(s.industry);
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh'));
  }, [stocks]);
  const filtered = useMemo(() => {
    const kw = q.trim().toUpperCase();
    const covOf = (code) => allCoverage[code] || { has5min: false, hasDay: false, intradayDates: 0 };
    return stocks.filter((s) => {
      if (market !== 'all' && s.market !== market) return false;
      if (hideDelisted && s.delisted) return false;
      if (industryFilter !== 'all') {
        if (industryFilter === '__none__') { if (s.industry) return false; }
        else if (s.industry !== industryFilter) return false;
      }
      // 本地数据存在性筛选(分时/5分钟/日线 各自 全部/有/无)
      const c = covOf(s.code);
      if (covIntraday === 'none' && c.intradayDates > 0) return false;
      if (covIntraday === 'has' && c.intradayDates === 0) return false;
      if (cov5min === 'none' && c.has5min) return false;
      if (cov5min === 'has' && !c.has5min) return false;
      if (covDay === 'none' && c.hasDay) return false;
      if (covDay === 'has' && !c.hasDay) return false;
      if (!kw) return true;
      return s.code.toUpperCase().includes(kw) || (s.name || '').toUpperCase().includes(kw);
    });
  }, [stocks, q, market, hideDelisted, industryFilter, allCoverage, covIntraday, cov5min, covDay]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paged = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // ---- 全市场本地数据覆盖(已有/缺失标记 + "无本地数据"筛选) ----
  // 一次性拉全量覆盖(单条 SQL, 毫秒级); covVersion 自增(回补任务完成后由 poll 触发)时重新拉取, 不翻页也更新。
  const loadAllCoverage = () => {
    api.stocksCoverageAll().then((r) => { if (r.ok) setAllCoverage(r.coverage || {}); }).catch(() => {});
  };
  useEffect(() => { loadAllCoverage(); }, [covVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- 批量回补进度轮询 ----
  // 行为对齐看盘页: 有任务在跑则持续轮询; 全部完成后保留结果 5s 再自动隐藏(自动关闭),
  // 避免"回补完成后进度面板一直挂着不消失"。
  const clearAutoClose = () => { if (autoCloseRef.current) { clearTimeout(autoCloseRef.current); autoCloseRef.current = null; } };
  const poll = async () => {
    try {
      const r = await api.backfillBulkStatus();
      if (!r.ok) return;
      // 执行日志 + 结果汇总(后端持久, 始终同步到前端, 不受任务面板自动关闭影响)
      if (Array.isArray(r.logs)) setLogs(r.logs);
      if (Array.isArray(r.queue)) setQueue(r.queue);
      if (r.lastResults) {
        const arr = Object.values(r.lastResults).sort((a, b) => (b.finishedAt || '').localeCompare(a.finishedAt || ''));
        setLastResults(arr);
      }
      // 过滤掉已关闭(自动5s隐藏 / 手动✕)的类型, 避免轮询反复"复活"已完成的任务 -> 修复"一会出现一会消失"
      const js = (r.jobs || []).filter((j) => !dismissedRef.current.has(j.type));
      // 回补任务完成(按类型独立): 刷新"当前展示股票"的本地数据覆盖, 无需翻页即可看到更新
      for (const j of js) {
        if (j.finished && !refreshedTypesRef.current.has(j.type)) {
          refreshedTypesRef.current.add(j.type);
          setCovVersion((v) => v + 1);
        }
      }
      if (js.length === 0) { clearAutoClose(); setJobs([]); return; }
      if (js.some((j) => !j.finished)) { clearAutoClose(); setJobs(js); return; } // 还在跑 -> 取消自动关闭
      // 全部完成: 展示最终结果, 5s 后自动关闭(并把该类型永久移出轮询, 不再复活)
      setJobs(js);
      if (!autoCloseRef.current) {
        autoCloseRef.current = setTimeout(() => {
          js.forEach((j) => dismissedRef.current.add(j.type));
          autoCloseRef.current = null;
          setJobs([]);
        }, 5000);
      }
    } catch (_) {}
  };
  useEffect(() => {
    poll();
    intervalRef.current = setInterval(poll, 1000);
    return () => { clearInterval(intervalRef.current); if (autoCloseRef.current) clearTimeout(autoCloseRef.current); };
  }, []);

  // 单个批量任务聚合状态(对齐看盘页 done/degraded/error/upToDate 语义)
  function jobStatus(j) {
    if (!j.finished) return 'running';
    if (j.fail > 0 && j.ok === 0 && j.skip === 0) return 'failed'; // 全部失败(如源不可用)
    if (j.degraded) return 'degraded';
    if (j.fail > 0) return 'done_fail'; // 部分失败
    if (j.ok === 0 && j.skip > 0) return 'uptodate'; // 全部已最新, 无需回补
    return 'done';
  }

  // ---- 触发回补 ----
  const fireBackfill = async (payload) => {
    const resp = await api.backfillBulk(payload);
    // 根据后端返回的排队位次给出轻提示(统一队列串行, 绝不丢请求)
    if (resp && resp.queued) {
      const pos = resp.position || 1;
      if (pos > 1) {
        setNotice(`已加入回补队列，当前排在第 ${pos} 位，前面还有 ${pos - 1} 个任务，将自动按顺序执行。`);
      } else {
        setNotice('已加入回补队列，即将开始执行。');
      }
      setTimeout(() => setNotice(''), pos > 1 ? 7000 : 4000);
    }
    return resp;
  };
  const startBulk = async (type, scope) => {
    clearAutoClose(); setJobs([]); // 新任务开始, 取消上一次的自动关闭
    dismissedRef.current.delete(type); // 若该类型曾被自动关闭, 允许重新显示
    refreshedTypesRef.current.delete(type); // 允许该类型完成后再次刷新覆盖
    let codes;
    if (scope === 'all') {
      // 「回补全部」: 指数视图传全部指数 code(不污染 A股全市场回补); A股视图传空=全市场
      codes = view === 'index' ? indicesAll : [];
    } else {
      codes = filtered.filter((s) => !s.delisted).map((s) => s.code); // 筛选回补也排除退市(后端兜底再过滤一次)
    }
    // 主按钮 = 全量历史回补(分时沿用"本地有即整只跳过"快路径, 全市场逐只顺序执行);
    // 最近N天/日期区间的"定向回补(对比缺失日期)"请使用下方专属按钮 startTargeted。
    await fireBackfill({ type, codes, force });
    poll();
  };
  const startSingle = async (type, code) => {
    clearAutoClose(); setJobs([]);
    dismissedRef.current.delete(type); // 若该类型曾被自动关闭, 允许重新显示
    refreshedTypesRef.current.delete(type); // 允许该类型完成后再次刷新覆盖
    await fireBackfill({ type, codes: [code], force });
    poll();
  };
  // 📅 分时定向回补(最近N天 / 日期区间): 独立按钮, 与实时看盘单只历史回补一致 ——
  // 不判断"本地有无分时"整只跳过, 而是对比目标窗口内"缺失的交易日"精确补缺(已有的日期不动)。
  const startTargeted = async (scope) => {
    clearAutoClose(); setJobs([]);
    dismissedRef.current.delete('intraday'); // 分时类(含定向)统一用 'intraday' 类型, 允许重新显示
    refreshedTypesRef.current.delete('intraday');
    let codes;
    if (scope === 'all') {
      codes = view === 'index' ? indicesAll : [];
    } else {
      codes = filtered.filter((s) => !s.delisted).map((s) => s.code);
    }
    const extra = { source: bfSource, targeted: true };
    if (bfMode === 'range') { extra.start = bfRangeStart; extra.end = bfRangeEnd; }
    else { extra.days = bfDays; } // 5000=全量历史(对比缺失日期); 用户可缩小到最近N天
    await fireBackfill({ type: 'intraday', codes, force: false, ...extra });
    poll();
  };

  const cov = (code) => allCoverage[code] || { has5min: false, hasDay: false, intradayDates: 0 };

  return (
    <div style={{ padding: 16 }}>
      {/* 分类切换: A股全市场 / 大盘指数（仅行情中心边界内, 不污染 A股股票池） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, color: '#666', marginRight: 4 }}>行情分类：</span>
        {[
          { k: 'stock', label: '📈 A股全市场' },
          { k: 'index', label: '📊 大盘指数' },
        ].map((t) => (
          <button key={t.k} onClick={() => { if (view !== t.k) { setView(t.k); if (t.k === 'index') setIndustryFilter('all'); setPage(1); } }}
            style={{ fontSize: 13, padding: '5px 14px', cursor: 'pointer', borderRadius: 16,
              border: '1px solid ' + (view === t.k ? '#1677ff' : '#ddd'),
              background: view === t.k ? '#1677ff' : '#fff', color: view === t.k ? '#fff' : '#555', fontWeight: view === t.k ? 600 : 400 }}>
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>{view === 'index' ? '📊 行情中心 · 大盘指数' : '📈 行情中心 · A股全市场'}</h3>
        <span style={{ fontSize: 12, color: '#888' }}>
          共收录 {stocks.length} 只{view === 'stock' && !listError ? '（沪/深/京）' : ''}
        </span>
        {listSource && (
          <span style={{ fontSize: 12, color: '#1565c0', background: '#e3f2fd', padding: '2px 8px', borderRadius: 10 }}>
            来源：{ view === 'index' ? '大盘指数清单（静态）' : ({ tdx: '通达信网关', tencent: '腾讯探测枚举', eastmoney: '东财 clist', local: '本地快照' }[listSource] || listSource) }
          </span>
        )}
        <button onClick={() => { setRefreshing(true); loadStocks(true).finally(() => setRefreshing(false)); }}
          style={{ fontSize: 13, padding: '4px 10px' }} disabled={refreshing || view === 'index'}>
          {refreshing ? '刷新中…' : '↻ 刷新列表'}
        </button>
      </div>

      {listError && (
        <div style={{ background: '#fff7e6', border: '1px solid #ffd591', color: '#ad6800', padding: '8px 12px', borderRadius: 6, fontSize: 13, marginBottom: 12 }}>
          ⚠️ {listError}
        </div>
      )}

      {notice && (
        <div style={{ background: '#e6f7ff', border: '1px solid #91d5ff', color: '#0958d9', padding: '8px 12px', borderRadius: 6, fontSize: 13, marginBottom: 12 }}>
          ℹ️ {notice}
        </div>
      )}

      {/* 批量回补工具栏 */}
      <div style={{ background: '#fafafa', border: '1px solid #eee', borderRadius: 8, padding: 12, marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>批量回补行情数据（按类型）</div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>{view === 'index' ? '回补全部指数' : '回补全部 A股'}</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {['intraday', '5min', 'day'].map((t) => (
                <button key={t} onClick={() => startBulk(t, 'all')}
                  style={{ fontSize: 13, padding: '5px 12px', cursor: 'pointer' }}>
                  {TYPE_LABEL[t]}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>{view === 'index' ? `回补当前指数（${filtered.length} 只）` : `回补当前筛选结果（${filtered.length} 只）`}</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {['intraday', '5min', 'day'].map((t) => (
                <button key={t} onClick={() => startBulk(t, 'filter')}
                  style={{ fontSize: 13, padding: '5px 12px', cursor: 'pointer' }}>
                  {TYPE_LABEL[t]}
                </button>
              ))}
            </div>
          </div>
          <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            强制刷新（5分钟/日线重抓已存在的，默认跳过本地已有）
          </label>
        </div>
        <div style={{ fontSize: 12, color: '#999', marginTop: 8 }}>
          说明：所有回补请求进入统一队列<b style={{ color: '#0958d9' }}>串行顺序执行</b>——若已有回补任务在跑，新请求自动排队等待、不丢请求；同一时刻仅执行一个任务，前面的完成后自动执行下一个。采用独立限流器（默认≈6.7 次/秒，可由 BULK_BACKFILL_MIN_GAP_MS 调），全市场逐只顺序执行（后台运行，可切页/切页面）；5分钟/日线、以及上方「分时行情（全量历史）」默认<b>本地有即整只跳过</b>、只补缺。下方「📅 分时定向回补」则用<b style={{ color: '#389e0d' }}>对比缺失日期补缺</b>（不整只跳过），与实时看盘页历史回补一致。完成后将汇总结果并推送企业微信通知。
        </div>
        {/* 📅 分时定向回补(最近N天 / 日期区间): 独立按钮, 与实时看盘单只历史回补一致 ——
            不判断"本地有无分时"整只跳过, 而是对比目标窗口内"缺失的交易日"精确补缺(已有的不动)。 */}
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed #e3e6ea' }}>
          <div style={{ fontSize: 12, color: '#1565c0', fontWeight: 600, marginBottom: 6 }}>📅 分时定向回补（最近N天 / 日期区间）· 对比缺失日期补缺，不整只跳过</div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <select value={bfSource} onChange={(e) => setBfSource(e.target.value)} style={{ fontSize: 13, padding: '3px 8px' }}>
              <option value="tdx">通达信(深·需启动网关)</option>
              <option value="eastmoney">东财(免费·约5日)</option>
            </select>
            <select value={bfMode} onChange={(e) => setBfMode(e.target.value)} style={{ fontSize: 13, padding: '3px 8px' }}>
              <option value="days">最近N天</option>
              <option value="range">日期区间</option>
            </select>
            {bfMode === 'days' ? (
              <>
                <input type="number" min={1} max={ibUncapped ? undefined : ibMaxDays} value={bfDays}
                  onChange={(e) => {
                    const v = Math.max(parseInt(e.target.value || '5000', 10), 1);
                    setBfDays(ibUncapped ? v : Math.min(v, ibMaxDays));
                  }}
                  style={{ width: 72, padding: '3px 8px', fontSize: 13 }} />
                <span style={{ fontSize: 12, color: '#888' }}>
                  {bfDays >= 5000 ? '交易日 (全量历史·仅回补本地缺失)' : ibUncapped ? `交易日 (不封顶·仅回补本地缺失)` : `交易日 (≤${ibMaxDays})`}
                </span>
              </>
            ) : (
              <>
                <input type="date" value={bfRangeStart} max={bfRangeEnd}
                  onChange={(e) => setBfRangeStart(e.target.value)} style={{ fontSize: 13, padding: '3px 8px' }} />
                <span style={{ fontSize: 12, color: '#888' }}>至</span>
                <input type="date" value={bfRangeEnd} max={todayLocal()}
                  onChange={(e) => setBfRangeEnd(e.target.value)} style={{ fontSize: 13, padding: '3px 8px' }} />
                <span style={{ fontSize: 12, color: bfSource === 'tdx' ? '#0a8' : '#c60' }}>
                  {bfSource === 'tdx' ? '通达信不封顶·仅回补本地缺失日期' : '东财仅截至今日≤5日'}
                </span>
              </>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#666' }}>立即回补：</span>
            <button onClick={() => startTargeted('all')}
              style={{ fontSize: 13, padding: '4px 12px', cursor: 'pointer', background: '#e6f7ff', border: '1px solid #91d5ff', color: '#0958d9' }}>
              {view === 'index' ? '回补全部指数' : '回补全部 A股'}
            </button>
            <button onClick={() => startTargeted('filter')}
              style={{ fontSize: 13, padding: '4px 12px', cursor: 'pointer', background: '#e6f7ff', border: '1px solid #91d5ff', color: '#0958d9' }}>
              回补当前筛选（{filtered.length} 只）
            </button>
          </div>
        </div>
        {/* 排队横幅: 展示当前待执行(不含正在跑)的任务链 */}
        {queue.length > 0 && (
          <div style={{ background: '#fffbe6', border: '1px solid #ffe58f', color: '#ad6800', padding: '8px 12px', borderRadius: 6, fontSize: 13, marginTop: 8 }}>
            ⏳ 回补队列排队中（共 {queue.length} 个待执行）：{' '}
            {queue.map((q, i) => (
              <span key={q.id}>
                {i > 0 && <span style={{ color: '#bfbfbf' }}> → </span>}
                <b>{TYPE_LABEL[q.type]}</b>{q.force ? '（强制）' : ''}
                {q.type === 'intraday' && (q.start && q.end
                  ? <span style={{ color: '#ad6800' }}>（{q.start}~{q.end}）</span>
                  : (q.days ? <span style={{ color: '#ad6800' }}>（最近{q.days >= 5000 ? '全量' : q.days}天）</span> : null))}
                {q.type === 'intraday' && q.targeted && <span style={{ color: '#389e0d' }}>（对比缺失日期）</span>}
              </span>
            ))}
            <span style={{ color: '#bfbfbf' }}> （正在执行的任务见下方进度面板）</span>
          </div>
        )}
      </div>

      {/* 结果汇总(持久展示, 不受进度面板自动关闭影响) */}
      {lastResults.length > 0 && (
        <div style={{ background: '#f6ffed', border: '1px solid #b7eb8f', borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: '#389e0d' }}>📋 最近回补结果汇总</div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {lastResults.map((s) => {
              const st = s.fail > 0 && s.ok === 0 && s.skip === 0 ? 'failed'
                : s.degraded ? 'degraded' : (s.ok === 0 && s.skip > 0 ? 'uptodate' : (s.fail > 0 ? 'done_fail' : 'done'));
              const color = { done: '#389e0d', done_fail: '#faad14', failed: '#cf1322', degraded: '#faad14', uptodate: '#1890ff' }[st];
              return (
                <div key={s.type} style={{ flex: '1 1 220px', minWidth: 220, border: '1px solid #e8e8e8', borderRadius: 6, padding: '8px 10px', background: '#fff' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <b style={{ fontSize: 13 }}>{TYPE_LABEL[s.type]}</b>
                    <span style={{ fontSize: 12, color }}>{st === 'done' ? '✅ 完成' : st === 'done_fail' ? '⚠️ 完成(有失败)' : st === 'failed' ? '❌ 失败' : st === 'degraded' ? '⚠️ 降级' : 'ℹ️ 全部已最新'}</span>
                  </div>
                  <div style={{ fontSize: 12, color: '#555', marginTop: 4, lineHeight: 1.7 }}>
                    <div>处理：<b>{s.total}</b> 只 · 数据源：{s.source === 'tdx' ? '通达信' : s.source === 'eastmoney' ? '东财' : (s.source || '默认')}{s.force ? '（强制）' : ''}</div>
                    {s.type === 'intraday' && (
                      <div>深度：{s.start && s.end ? `${s.start}~${s.end}` : (s.days ? (s.days >= 5000 ? '全量历史' : `最近 ${s.days} 天`) : '全量历史')}{s.targeted ? ' · 对比缺失日期补缺' : ''}</div>
                    )}
                    <div>成功：<b style={{ color: '#389e0d' }}>{s.ok}</b> · 跳过：<b>{s.skip}</b> · 失败：<b style={{ color: s.fail ? '#cf1322' : '#555' }}>{s.fail}</b></div>
                    <div>写入：<b>{s.points}</b> 点</div>
                    <div>耗时：{elapsedFmt(s.durationMs)} <span style={{ color: '#999' }}>· {fmtTime(s.finishedAt)}</span></div>
                    {(s.fail > 0 || s.degraded) && s.lastErr && (
                      <div style={{ color: '#cf1322', marginTop: 2 }}>末次：{s.lastErr}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 执行日志(后端持久, 可折叠; 带时间戳, 三类回补混排) */}
      <div style={{ border: '1px solid #eee', borderRadius: 8, marginBottom: 12, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 12px', background: '#fafafa', cursor: 'pointer' }}
          onClick={() => setShowLog((v) => !v)}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>📝 执行日志{logs.length ? `（${logs.length} 行）` : ''}</span>
          <span style={{ fontSize: 12, color: '#888' }}>{showLog ? '收起 ▲' : '展开 ▼'}</span>
        </div>
        {showLog && (
          <pre style={{ margin: 0, padding: 10, maxHeight: 220, overflow: 'auto', fontSize: 12, lineHeight: 1.6, background: '#1e1e1e', color: '#d4d4d4', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
{logs.length ? logs.join('\n') : '（暂无日志）'}
          </pre>
        )}
      </div>

      {/* 进度(与看盘页回补进度同款详细面板: 终态自动关闭 + 分状态 + 已写入带说明) */}
      {jobs.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          {jobs.map((j) => {
            const st = jobStatus(j);
            const judging = !j.finished && j.phase === 'judging'; // 分时: 多线程判断本地有无阶段
            const meta = {
              running:   { text: judging ? '🧭 判断本地数据…（多线程）' : '🔄 回补中…', color: '#1890ff' },
              done:      { text: '✅ 回补完成', color: '#389e0d' },
              done_fail: { text: '⚠️ 完成（有失败）', color: '#faad14' },
              failed:    { text: '❌ 回补失败', color: '#cf1322' },
              degraded:  { text: '⚠️ 数据源降级', color: '#faad14' },
              uptodate:  { text: 'ℹ️ 全部已是最新', color: '#1890ff' },
            }[st];
            const pct = j.total ? Math.round((j.done / j.total) * 100) : (j.finished ? 100 : 0);
            const elapsed = j.startedAt ? Math.max(0, Date.now() - j.startedAt) : 0;
            const speed = elapsed > 0 ? j.done / (elapsed / 1000) : 0; // 只/秒
            const eta = (pct > 2 && pct < 100) ? Math.round((elapsed / pct) * (100 - pct)) : null;
            const curName = j.currentCode ? (stocks.find((s) => s.code === j.currentCode)?.name || '') : '';
            const srcLabel = j.source === 'tdx' ? '通达信' : j.source === 'eastmoney' ? '东财' : (j.source || '默认源');
            // 终态结论文案
            let detail;
            if (st === 'failed') detail = '回补失败：' + (j.error || j.lastErr || '所有股票均无数据 / 数据源不可用');
            else if (st === 'degraded') detail = '⚠️ 数据源降级：' + (j.lastErr || '部分数据不可用，建议切换数据源重试');
            else if (st === 'done_fail') detail = '⚠️ 部分失败：' + (j.lastErr || '');
            else if (st === 'uptodate') detail = `无需回补：跳过 ${j.skip} 只（本地已是最新，无新数据写入）`;
            else if (st === 'done') detail = j.error ? ('错误：' + j.error) : (j.lastErr ? ('末次异常：' + j.lastErr) : `成功 ${j.ok} 只 · 跳过 ${j.skip} 只`);
            else detail = j.lastErr ? ('⚠️ ' + j.lastErr) : '任务进行中…';
            return (
              <div key={j.type} style={{ border: '1px solid #e8e8e8', borderRadius: 8, padding: 10, marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: meta.color }}>
                    <b>{TYPE_LABEL[j.type]}</b> · {meta.text} <span style={{ color: '#666' }}>{pct}%</span>
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 12, color: '#666' }}>
                      已处理 {j.done}/{j.total} · 成功 {j.ok} · 跳过 {j.skip} · 失败 {j.fail}
                    </span>
                    {j.finished && (
                      <button onClick={() => { clearAutoClose(); dismissedRef.current.add(j.type); setJobs((prev) => prev.filter((x) => x.type !== j.type)); }}
                        style={{ fontSize: 12, padding: '1px 8px', cursor: 'pointer' }}>✕ 关闭</button>
                    )}
                  </span>
                </div>
                <div style={{ background: '#eee', height: 8, borderRadius: 4, margin: '6px 0', overflow: 'hidden' }}>
                  <div style={{ width: pct + '%', height: '100%', background: meta.color, transition: 'width .3s' }} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '3px 16px', marginTop: 6, fontSize: 12, color: '#555' }}>
                  <span>📌 当前：{j.finished ? '—' : (judging ? '多线程判断本地数据中…' : (j.currentCode ? `${j.currentCode}${curName ? '（' + curName + '）' : ''}` : '准备中'))}</span>
                  <span>📝 已写入：<b>{j.points || 0}</b> 点{j.points === 0 && j.skip > 0 ? '（全部已最新）' : ''}</span>
                  <span>⏱ 已耗时：{elapsedFmt(elapsed)}</span>
                  <span>⚡ 速度：{speed.toFixed(1)} 只/秒{eta ? ' · 预计剩 ' + Math.round(eta / 1000) + 's' : ''}</span>
                  <span>🔌 数据源：{srcLabel}{j.force ? '（强制刷新）' : ''}</span>
                  <span>🎯 范围：{j.total} 只{j.force ? '（含本地已有）' : '（仅补缺）'}</span>
                </div>
                <div style={{ fontSize: 12, color: st === 'failed' || st === 'degraded' ? '#cf1322' : (st === 'uptodate' ? '#1890ff' : '#999'), marginTop: 4 }}>
                  {detail}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 搜索 + 筛选 */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
        <input placeholder="搜索代码 / 名称" value={q}
          onChange={(e) => { setQ(e.target.value); setPage(1); }}
          style={{ width: 200, padding: '5px 10px', fontSize: 13 }} />
        <select value={market} onChange={(e) => { setMarket(e.target.value); setPage(1); }} style={{ padding: '5px 10px', fontSize: 13 }}>
          <option value="all">全部市场</option>
          <option value="sh">沪市</option>
          <option value="sz">深市</option>
          <option value="bj">京市/北交所</option>
        </select>
        {view === 'stock' && (
          <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, marginLeft: 12 }}>
            <input type="checkbox" checked={hideDelisted} onChange={(e) => { setHideDelisted(e.target.checked); setPage(1); }} />
            隐藏退市
          </label>
        )}
        {view === 'stock' && (
          <select value={industryFilter} onChange={(e) => { setIndustryFilter(e.target.value); setPage(1); }} style={{ padding: '5px 10px', fontSize: 13, marginLeft: 12 }}>
            <option value="all">全部行业</option>
            <option value="__none__">未分类</option>
            {industryOptions.map((ind) => <option key={ind} value={ind}>{ind}</option>)}
          </select>
        )}
        <span style={{ fontSize: 12, color: '#888', marginLeft: 16 }}>本地数据：</span>
        <select value={covIntraday} onChange={(e) => { setCovIntraday(e.target.value); setPage(1); }} style={{ padding: '5px 8px', fontSize: 13 }}>
          <option value="all">分时·全部</option>
          <option value="none">分时·无数据</option>
          <option value="has">分时·有数据</option>
        </select>
        <select value={cov5min} onChange={(e) => { setCov5min(e.target.value); setPage(1); }} style={{ padding: '5px 8px', fontSize: 13 }}>
          <option value="all">5分·全部</option>
          <option value="none">5分·无数据</option>
          <option value="has">5分·有数据</option>
        </select>
        <select value={covDay} onChange={(e) => { setCovDay(e.target.value); setPage(1); }} style={{ padding: '5px 8px', fontSize: 13 }}>
          <option value="all">日线·全部</option>
          <option value="none">日线·无数据</option>
          <option value="has">日线·有数据</option>
        </select>
        <span style={{ fontSize: 12, color: '#888' }}>
          第 {safePage} / {totalPages} 页 · 共 {filtered.length} 只{stocks.some((s) => s.delisted) ? `（含退市 ${stocks.filter((s) => s.delisted).length} 只）` : ''}
        </span>
      </div>

      {/* 表格 */}
      <div style={{ overflowX: 'auto', border: '1px solid #eee', borderRadius: 8 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#fafafa', textAlign: 'left' }}>
              <th style={th}>代码</th>
              <th style={th}>名称</th>
              <th style={th}>市场</th>
              <th style={th}>行业</th>
              <th style={th}>本地数据</th>
              <th style={th}>回补操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} style={{ padding: 20, textAlign: 'center', color: '#999' }}>加载中…</td></tr>
            )}
            {!loading && paged.length === 0 && (
              <tr><td colSpan={6} style={{ padding: 20, textAlign: 'center', color: '#999' }}>无匹配股票</td></tr>
            )}
            {!loading && paged.map((s) => {
              const c = cov(s.code);
              const del = !!s.delisted;
              return (
                <tr key={s.code} style={{ borderTop: '1px solid #f0f0f0', background: del ? '#fff1f0' : 'transparent' }}>
                  <td style={td}>{s.code}</td>
                  <td style={td}>{s.name}
                    {del && <span style={{ marginLeft: 6, fontSize: 11, padding: '0px 5px', borderRadius: 4, background: '#cf1322', color: '#fff', fontWeight: 600 }}>退</span>}
                    <span style={{ marginLeft: 6, fontSize: 11, padding: '0px 5px', borderRadius: 4, fontWeight: 600,
                      background: (s.securityShort === '股') ? '#f0f0f0' : (s.securityShort === '债' ? '#fff1f0' : s.securityShort === '基' ? '#e6f4ff' : s.securityShort === '指' ? '#f9f0ff' : s.securityShort === 'B' ? '#fff7e6' : '#f0f0f0'),
                      color: (s.securityShort === '股') ? '#999' : (s.securityShort === '债' ? '#cf1322' : s.securityShort === '基' ? '#1677ff' : s.securityShort === '指' ? '#722ed1' : s.securityShort === 'B' ? '#d46b08' : '#999') }}>
                      {s.securityShort}
                    </span>
                  </td>
                  <td style={td}>{s.market === 'sh' ? '沪' : s.market === 'sz' ? '深' : '京'}</td>
                  <td style={td}>
                    {s.industry
                      ? <span style={{ fontSize: 12, padding: '1px 7px', borderRadius: 4, background: '#f6ffed', color: '#389e0d', border: '1px solid #b7eb8f' }}>{s.industry}</span>
                      : <span style={{ fontSize: 12, color: '#bbb' }}>未分类</span>}
                  </td>
                  <td style={td}>
                    <span style={tag(c.has5min)}>5分{c.has5min ? '✓' : '✗'}</span>{' '}
                    <span style={tag(c.hasDay)}>日K{c.hasDay ? '✓' : '✗'}</span>{' '}
                    <span style={tag(c.intradayDates > 0)}>分时{c.intradayDates > 0 ? c.intradayDates + '天' : '✗'}</span>
                  </td>
                  <td style={td}>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {['intraday', '5min', 'day'].map((t) => (
                        <button key={t} onClick={() => !del && startSingle(t, s.code)}
                          disabled={del}
                          title={del ? '已退市，不获取行情数据' : ''}
                          style={{ fontSize: 12, padding: '3px 8px', cursor: del ? 'not-allowed' : 'pointer', opacity: del ? 0.5 : 1 }}>
                          {t === 'intraday' ? '分时' : t === '5min' ? '5分' : '日K'}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 分页 */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
        <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={safePage <= 1} style={{ fontSize: 13, padding: '4px 10px' }}>上一页</button>
        <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={safePage >= totalPages} style={{ fontSize: 13, padding: '4px 10px' }}>下一页</button>
        <span style={{ fontSize: 12, color: '#888' }}>{safePage} / {totalPages}</span>
      </div>
    </div>
  );
}

// ISO 时间戳 -> 本地可读 HH:MM:SS
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 毫秒耗时格式化(回补进度面板用)
function elapsedFmt(ms) {
  if (!ms || ms < 0) return '0ms';
  if (ms < 1000) return Math.round(ms) + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m${s}s`;
}

const th = { padding: '8px 10px', fontWeight: 600, whiteSpace: 'nowrap' };
const td = { padding: '7px 10px', whiteSpace: 'nowrap' };
function tag(on) {
  return {
    fontSize: 12, padding: '1px 6px', borderRadius: 4,
    background: on ? '#e6f7e6' : '#fff1f0',
    color: on ? '#389e0d' : '#cf1322',
    border: '1px solid ' + (on ? '#b7eb8f' : '#ffa39e'),
  };
}
