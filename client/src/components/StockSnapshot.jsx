import React, { forwardRef, useEffect, useRef, useState, useMemo } from 'react';
import { api, fmt } from '../api';
import Chart, { minuteDualAxisOption } from './Chart';
import { computeIntradayT } from '../indicators/tIndex';
import TTDecisionPanel from './TTDecisionPanel';

/** 本地(北京时区)今日 YYYY-MM-DD */
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 做T决策「三模块」快照组件（自包含、可截图）。
 * 按实时看盘页布局渲染：
 *   左（~66%）：当日分时图（含顶/底标记 + 日内T指标副图）
 *   右（~34%）：做T决策面板 + 当前分时形态概率匹配
 * 外层容器已 forwardRef，供调用方 html2canvas 截成一张完整图。
 * props.onReady(ready) 在全部数据加载完成后触发一次，便于离屏挂载后截图。
 */
const StockSnapshot = forwardRef(function StockSnapshot({ code, name, signal, onReady }, ref) {
  const [q, setQ] = useState(null);
  const [minute, setMinute] = useState([]);
  const [minutePreclose, setMinutePreclose] = useState(null);
  const [tbMarks, setTbMarks] = useState(null);
  const [replay, setReplay] = useState(null);
  const [gap, setGap] = useState(0.96);
  const [winRate, setWinRate] = useState(95.8);
  const readyNotified = useRef(false);

  useEffect(() => {
    if (!code) return;
    let alive = true;
    readyNotified.current = false;
    setMinute([]); setReplay(null); setTbMarks(null); setQ(null);
    const rd = todayLocal();
    Promise.all([
      api.quote([code]).then((r) => { if (alive && r && r.ok && r.data && r.data[0]) setQ(r.data[0]); }).catch(() => {}),
      api.minute(code).then((r) => { if (alive) { setMinute(r.data || []); if (r.preclose) setMinutePreclose(r.preclose); } }).catch(() => {}),
      api.dotTopsBottoms(code).then((r) => { if (alive) setTbMarks(r.ok ? (r.marks || []) : null); }).catch(() => { if (alive) setTbMarks(null); }),
      api.dotReplay(code, rd, true).then((r) => { if (alive && r.ok) setReplay(r); }).catch(() => {}),
      api.backtest({ code, strategy: 't0', qty: 2000, variant: 'standard' }).then((r) => {
        if (!alive || !r.ok) return;
        if (r.median_gap_pct) setGap(r.median_gap_pct);
        if (r.metrics) setWinRate(r.metrics.win_rate);
      }).catch(() => {}),
    ]);
    return () => { alive = false; };
  }, [code]);

  // 数据齐备后通知父级（每个 code 仅一次），便于离屏截图。
  // 仅依赖 分时+报价(必要项)；形态概率(replay)若缺失也不阻塞截图(概率面板只是可选增强)。
  useEffect(() => {
    if (readyNotified.current) return;
    if (minute.length && q) {
      readyNotified.current = true;
      if (onReady) onReady(true);
    }
  }, [minute, replay, q, onReady]);

  const intra = useMemo(() => (minute.length ? computeIntradayT(minute) : null), [minute]);
  const intradayAvg = useMemo(() => (minute.length ? minute[minute.length - 1].avg : null), [minute]);
  const livePrevClose = useMemo(() => {
    if (q && q.preclose) return Number(q.preclose);
    if (q && q.prev_close) return Number(q.prev_close);
    if (minutePreclose && minutePreclose > 0) return minutePreclose;
    return minute.length ? minute[0].price : undefined;
  }, [q, minutePreclose, minute]);

  const mOpt = useMemo(() => minuteDualAxisOption(minute, intra, { topsBottoms: tbMarks, prevClose: livePrevClose }),
    [minute, intra, tbMarks, livePrevClose]);

  // 概率匹配（用当日完整回放最后一窗的概率分布）
  const N = replay ? replay.count : 0;
  const curPattern = (replay && replay.patternProbs && N > 0) ? replay.patternProbs[N - 1] : null;

  return (
    <div ref={ref} style={{ background: '#fff', color: '#1a1a1a', padding: 12, fontFamily: 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif' }}>
      {/* 信号摘要带: 仅在传入 signal 时显示(后台监控/测试推送), 与文字通知字段对齐 */}
      {signal && (
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', background: '#f3f6fb', border: '1px solid #e3e6ea', borderRadius: 8, padding: '6px 10px', marginBottom: 8, fontSize: 13 }}>
          <span style={{ fontWeight: 700, color: signal.type === 'bottom' ? '#1aa260' : '#e23c3c' }}>{signal.type === 'bottom' ? '🔵 底部信号' : '🔴 顶部信号'}</span>
          <span>置信度：{signal.confidence === 'high' ? '高' : signal.confidence === 'medium' ? '中' : '低'}</span>
          {signal.dev != null && <span>乖离：{Number(signal.dev).toFixed(2)}%</span>}
          <span>背离：{signal.divergence === 'bullish' ? '底背离(看多)' : signal.divergence === 'bearish' ? '顶背离(看空)' : '无'}</span>
          {signal.volRatio != null && <span>量比：{Number(signal.volRatio).toFixed(2)}</span>}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, fontSize: 16 }}>{q ? q.name : (name || code)}</span>
        {q && <span className={'bigprice ' + fmt.cls(q.change_pct)} style={{ fontSize: 20 }}>{fmt.price(q.price)}</span>}
        {q && <span className={fmt.cls(q.change_pct)} style={{ fontSize: 13 }}>{fmt.pct(q.change_pct)}</span>}
        {q && <span style={{ fontSize: 12, color: '#888' }}>高 {fmt.price(q.high)} 低 {fmt.price(q.low)} 换手 {(q.turnover != null ? q.turnover : 0).toFixed(2)}%</span>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'row', gap: 12, alignItems: 'stretch' }}>
        {/* 左：当日分时图（含顶/底标记 + 日内T副图） */}
        <div style={{ flex: '0 0 66%', minWidth: 0 }}>
          <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>📉 当日分时 <span style={{ fontSize: 11, color: '#888' }}>15s 刷新</span></h3>
          {minute.length
            ? <Chart option={mOpt} height={520} />
            : <div className="loading">暂无分时数据</div>}
        </div>
        {/* 右：做T决策面板 + 当前分时形态概率匹配 */}
        <div style={{ flex: '1 1 34%', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <TTDecisionPanel quote={q} avg={intradayAvg} gapPct={gap} winRate={winRate} minute={minute} minutePreclose={minutePreclose} replayPrevClose={replay && replay.prevClose} />
          {replay && (
            <div className="panel" style={{ minWidth: 0, background: '#fff' }}>
              <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>🧩 当前分时形态概率匹配 <span style={{ fontSize: 11, color: '#888' }}>盘中实时</span></h3>
              {curPattern ? (
                (() => {
                  const probs = curPattern.probs || [];
                  const best = probs.length ? probs.reduce((a, b) => (b.prob > a.prob ? b : a), probs[0]) : null;
                  const bestPat = best ? (replay.patterns || []).find((c) => c.id === best.id) : null;
                  const bestName = bestPat ? bestPat.name : (curPattern.bestName || '—');
                  const bestProb = best ? best.prob : (curPattern.bestProb || 0);
                  return (
                    <div style={{ display: 'flex', gap: 14, alignItems: 'stretch' }}>
                      <div style={{ flex: '0 0 140px', display: 'flex', flexDirection: 'column', justifyContent: 'center', borderRight: '1px solid #e3e6ea', paddingRight: 14 }}>
                        <div style={{ fontSize: 12, color: '#6b7280' }}>最佳匹配 · 实时匹配率</div>
                        <div style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.3, marginTop: 2 }}>{bestName}</div>
                        <div style={{ fontSize: 30, fontWeight: 800, color: '#2f6fed', lineHeight: 1.1, marginTop: 4 }}>{(bestProb * 100).toFixed(1)}%</div>
                      </div>
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
              ) : <div className="muted">回放加载中…</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

export default StockSnapshot;
