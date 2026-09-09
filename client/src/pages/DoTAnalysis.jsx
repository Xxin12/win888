import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as echarts from 'echarts';
import { api, normCode } from '../api';
import IntradayTradeChart from '../components/IntradayTradeChart';
import { minuteOption } from '../components/Chart';

// 通用 ECharts 容器
function EChart({ option, height = 280 }) {
  const elRef = useRef(null);
  const chartRef = useRef(null);
  useEffect(() => {
    if (!elRef.current) return;
    const c = echarts.init(elRef.current);
    chartRef.current = c;
    let ro;
    try { if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(() => c.resize()); ro.observe(elRef.current); } } catch (_) {}
    return () => { try { ro && ro.disconnect(); } catch (_) {} try { c.dispose(); } catch (_) {} };
  }, []);
  useEffect(() => { if (chartRef.current && option) chartRef.current.setOption(option, true); }, [option]);
  return <div ref={elRef} style={{ width: '100%', height }} />;
}

const WD = ['周一', '周二', '周三', '周四', '周五'];
function histBins(amps, bins = 20) {
  if (!amps || !amps.length) return { labels: [], counts: [] };
  const min = Math.min(...amps), max = Math.max(...amps);
  const w = (max - min) / bins || 1;
  const counts = new Array(bins).fill(0);
  for (const a of amps) { let i = Math.min(bins - 1, Math.floor((a - min) / w)); counts[i]++; }
  const labels = counts.map((_, i) => +(min + w * (i + 0.5)).toFixed(1));
  return { labels, counts };
}
function Card({ title, children, style }) {
  return (
    <div className="card" style={{ padding: 14, marginBottom: 14, ...(style || {}) }}>
      {title && <div style={{ fontWeight: 600, marginBottom: 10 }}>{title}</div>}
      {children}
    </div>
  );
}
function Stat({ label, value, sub }) {
  return (
    <div style={{ display: 'inline-block', minWidth: 110, margin: '4px 14px 4px 0' }}>
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{value}</div>
      {sub && <div className="muted" style={{ fontSize: 11 }}>{sub}</div>}
    </div>
  );
}

export default function DoTAnalysis() {
  const [watch, setWatch] = useState([]);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [data, setData] = useState(null);     // analyze 结果
  const [dates, setDates] = useState([]);     // 分时日期列表
  const [tab, setTab] = useState('amp');
  const [dayDate, setDayDate] = useState('');
  const [day, setDay] = useState(null);
  const [dayLoading, setDayLoading] = useState(false);
  const [exampleDate, setExampleDate] = useState(''); // 形态图鉴示例
  const [matchDate, setMatchDate] = useState('');     // 该日形态匹配
  const [matchRes, setMatchRes] = useState(null);
  const [cmp, setCmp] = useState(null);
  const [bt, setBt] = useState(null);
  const [th, setTh] = useState(null);
  const [addCode, setAddCode] = useState('');
  const [toast, setToast] = useState('');
  // 分时回放状态
  const [replay, setReplay] = useState(null);
  const [rpIndex, setRpIndex] = useState(0);   // 已展示的分时根数 0..N
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);        // 0.5/1/2/4 倍速（1× 基准=全天约30秒）
  const rpIndexRef = useRef(0);

  const showToast = (m) => { setToast(m); setTimeout(() => setToast(''), 3500); };

  const loadWatch = useCallback(() => {
    api.watchlist().then((r) => {
      const list = (r.data || []).map((x) => ({ code: x.code, name: x.name }));
      setWatch(list);
      if (!code && list.length) setCode(list[0].code);
    }).catch(() => {});
  }, [code]);

  useEffect(() => { loadWatch(); api.dotThresholds().then((r) => r.thresholds && setTh(r.thresholds)).catch(() => {}); }, []);

  const runAnalyze = useCallback(() => {
    if (!code) return;
    setLoading(true); setErr('');
    Promise.all([api.dotAnalyze(code), api.intradayDates(code)])
      .then(([a, d]) => {
        setData(a);
        const ds = (d.dates || []).slice().sort().reverse();
        setDates(ds);
        if (a.ok && a.patterns && a.patterns.ok && a.patterns.clusters[0]) setExampleDate(a.patterns.clusters[0].exampleDate);
        if (ds.length) {
          const last = ds[0];
          setDayDate(last);
          api.dotDay(code, last).then((r) => setDay(r)).catch(() => {}); // 自动加载最近一日顶底
          loadReplay(last); // 同时加载回放数据
        }
        setLoading(false);
      })
      .catch((e) => { setErr(e.message); setLoading(false); });
  }, [code]);

  // 加载某日的分时回放数据（原始分时 + 盘后复盘信号含 discoveredAt）
  const loadReplay = useCallback((dt) => {
    if (!dt || !code) return;
    api.dotReplay(code, dt).then((r) => {
      if (r.ok) { setReplay(r); setRpIndex(r.count); rpIndexRef.current = r.count; setPlaying(false); }
      else { setReplay(null); }
    }).catch(() => setReplay(null));
  }, [code]);

  useEffect(() => { if (code) runAnalyze(); }, [code, runAnalyze]);

  const onAdd = () => {
    const c = normCode(addCode);
    if (!c) return showToast('请输入有效代码');
    api.addWatch({ code: c }).then(() => { setAddCode(''); loadWatch(); showToast('已添加 ' + c + '（分析需先补齐数据）'); })
      .catch(() => showToast('添加失败'));
  };
  const onBackfill = () => {
    if (!code) return;
    api.backfillBulk({ type: 'day', codes: [code] }).catch(() => {});
    api.intradayBackfill(code, 120).catch(() => {});
    showToast('已触发「日K+分时」回补，请到「行情中心/每日补齐」查看进度');
  };
  const onLoadDay = (dt) => {
    if (!dt) return;
    setDayLoading(true); setDay(null); setMatchRes(null);
    api.dotDay(code, dt).then((r) => { setDay(r); setDayLoading(false); }).catch((e) => { setErr(e.message); setDayLoading(false); });
    loadReplay(dt);
  };
  const onMatch = (dt) => {
    if (!dt) return;
    api.dotDay(code, dt).then((r) => setMatchRes(r.patternMatch)).catch(() => {});
  };
  const onNotify = () => {
    api.dotNotifyToday(code).then((r) => {
      if (r.ok) showToast('已推送今日信号 ' + (r.pushed || 0) + ' 条' + (r.signals && r.signals.length ? '：' + r.signals.map((s) => s.type === 'top' ? '顶' : '底').join('/') : ''));
      else showToast('推送失败：' + (r.reason || ''));
    }).catch((e) => showToast('推送异常：' + e.message));
  };
  const onCompare = () => {
    const codes = watch.map((w) => w.code);
    if (!codes.length) return showToast('自选股为空');
    api.dotCompare(codes).then((r) => setCmp(r)).catch((e) => showToast('对比失败：' + e.message));
  };
  const onBacktest = () => { if (!code) return; api.dotBacktest(code).then((r) => setBt(r)).catch((e) => showToast('回测失败：' + e.message)); };
  const onSaveTh = () => {
    if (!th) return;
    api.dotSaveThresholds(th).then((r) => { if (r.ok) { setTh(r.thresholds); showToast('阈值已保存'); runAnalyze(); } })
      .catch((e) => showToast('保存失败：' + e.message));
  };

  // ---------- 分时回放：播放控制 + 盘中信号 vs 盘后复盘验证 ----------
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

  const shownRows = replay ? replay.rows.slice(0, rpIndex) : [];
  const curTime = rpIndex > 0 && replay ? replay.rows[rpIndex - 1].t : '';
  const finalSignals = replay ? replay.signals : [];
  const inPlay = finalSignals.filter((s) => s.discoveredAt <= rpIndex); // 盘中已发出
  const committed = inPlay.filter((s) => finalSignals.some((f) => f.type === s.type && f.index === s.index)); // 与盘后一致(已提交)
  const tentative = inPlay.filter((s) => !finalSignals.some((f) => f.type === s.type && f.index === s.index)); // 盘尾未定型极值
  const total = finalSignals.length;
  const reached = finalSignals.filter((s) => s.index < rpIndex).length; // 盘后复盘里此刻已发生的拐点
  const allMatched = rpIndex >= N && total > 0 && committed.length === total;

  // 回放主图：切片数据 + 顶底标记（复用 minuteOption.topsBottoms）
  const replayOption = shownRows.length
    ? minuteOption(shownRows, null, { topsBottoms: inPlay.map((s) => ({ type: s.type, time: s.time, price: s.price, dev: s.dev })) })
    : null;

  // ---------- 振幅图表 ----------
  const amp = data && data.amplitude;
  const ampHist = amp && amp.ok ? histBins(amp.amps, 20) : { labels: [], counts: [] };
  const ampHistOption = {
    grid: { left: 40, right: 16, top: 20, bottom: 30 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: ampHist.labels, name: '振幅%', axisLabel: { fontSize: 10 } },
    yAxis: { type: 'value', name: '天数' },
    series: [{ type: 'bar', data: ampHist.counts, itemStyle: { color: '#c0392b' } }],
  };
  const weekdayOption = amp && amp.ok ? {
    grid: { left: 40, right: 16, top: 20, bottom: 30 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: WD },
    yAxis: { type: 'value', name: '平均振幅%' },
    series: [{ type: 'bar', data: WD.map((_, i) => amp.weekday[i + 1] ? amp.weekday[i + 1].mean : 0), itemStyle: { color: '#2980b9' } }],
  } : null;

  const insufficient = data && (!data.coverage || !data.coverage.hasDay || data.coverage.intradayDates === 0);

  return (
    <div style={{ padding: 6 }}>
      {toast && <div style={{ position: 'fixed', right: 20, bottom: 20, background: '#2c3e50', color: '#fff', padding: '10px 14px', borderRadius: 8, zIndex: 99 }}>{toast}</div>}

      {/* 顶部工具栏 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <select value={code} onChange={(e) => setCode(e.target.value)} style={{ padding: '6px 8px' }}>
          {watch.map((w) => <option key={w.code} value={w.code}>{w.name || w.code}（{w.code.replace(/^(sh|sz|bj)/, '')}）</option>)}
        </select>
        <button className="btn" onClick={runAnalyze}>🔄 刷新分析</button>
        <input value={addCode} onChange={(e) => setAddCode(e.target.value)} placeholder="输入代码如 002027" style={{ padding: '6px 8px', width: 130 }} />
        <button className="btn" onClick={onAdd}>➕ 添加自选</button>
        <button className="btn" onClick={onBackfill}>⬇️ 补齐数据</button>
        <span className="muted" style={{ fontSize: 12 }}>
          {data && data.coverage ? `日K:${data.coverage.hasDay ? '有' : '缺'} · 分时日期:${data.coverage.intradayDates || 0}` : ''}
        </span>
      </div>

      {insufficient && <div className="card" style={{ padding: 12, marginBottom: 12, background: '#fff7e6', border: '1px solid #ffd591' }}>⚠️ 数据不足：该股本地日K或分时缺失。可点「补齐数据」回补后刷新；本功能仅分析本地已存储数据。</div>}
      {err && <div className="muted" style={{ color: '#e23c3c' }}>{err}</div>}
      {loading && <div className="muted">分析中…</div>}

      {/* Tab 导航 —— 分段按钮式，显著可点 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14, padding: '8px 10px', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: 'var(--shadow)' }}>
        {[['amp', '📊 振幅统计'], ['pattern', '🧩 形态图鉴'], ['tb', '🔺 顶底分析'], ['ref', '🎯 参考卡'], ['cmp', '⚖️ 多股对比'], ['th', '⚙️ 阈值配置'], ['bt', '🧪 回测验证']].map(([k, l]) => {
          const active = tab === k;
          return (
            <button
              key={k}
              onClick={() => setTab(k)}
              style={{
                padding: '9px 16px', fontSize: 14, fontWeight: active ? 700 : 500,
                borderRadius: 8, cursor: 'pointer', whiteSpace: 'nowrap',
                border: active ? '1px solid var(--accent)' : '1px solid var(--line)',
                background: active ? 'var(--accent)' : '#fff',
                color: active ? '#fff' : 'var(--ink)',
                boxShadow: active ? '0 2px 8px rgba(47,111,237,.28)' : 'none',
                transition: 'all .15s',
              }}
              onMouseEnter={(e) => { if (!active) { e.currentTarget.style.background = '#eef3ff'; e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.color = 'var(--accent)'; } }}
              onMouseLeave={(e) => { if (!active) { e.currentTarget.style.background = '#fff'; e.currentTarget.style.borderColor = 'var(--line)'; e.currentTarget.style.color = 'var(--ink)'; } }}
            >{l}</button>
          );
        })}
      </div>

      {/* ---------- 振幅统计 ---------- */}
      {tab === 'amp' && data && (
        <>
          {amp && amp.ok ? (
            <>
              <Card title="日振幅统计（近5年）">
                <Stat label="最大振幅" value={amp.max + '%'} />
                <Stat label="平均振幅" value={amp.avg + '%'} />
                <Stat label="中位数" value={amp.median + '%'} />
                <Stat label="标准差" value={amp.std} />
                <Stat label="P25~P75" value={amp.p25 + '~' + amp.p75} sub="预期区间" />
                <Stat label="P10~P90" value={amp.p10 + '~' + amp.p90} />
                <Stat label="近20日均值" value={amp.recent20Mean + '%'} sub={'vs5年 ' + (amp.trend >= 0 ? '+' : '') + amp.trend} />
                <Stat label="大盘(沪深300)均值" value={amp.benchmarkMean != null ? amp.benchmarkMean + '%' : '—'} />
                <Stat label="波动倍数" value={amp.benchmarkRatio != null ? amp.benchmarkRatio + '×' : '—'} sub="个股/大盘" />
              </Card>
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                <Card title="振幅分布直方图" style={{ flex: 1, minWidth: 320 }}><EChart option={ampHistOption} height={260} /></Card>
                <Card title="星期效应（各日平均振幅）" style={{ flex: 1, minWidth: 320 }}><EChart option={weekdayOption} height={260} /></Card>
              </div>
              <Card title="说明">
                <div className="muted" style={{ fontSize: 13, lineHeight: 1.7 }}>
                  振幅口径 = (当日最高−最低) / 昨收 ×100%。预期振幅区间取历史 P25~P75，做T空间可参考此区间。
                  「波动倍数」&gt;1 表示个股波动高于大盘，更适合做T；「近20日 vs 5年趋势」为正说明近期波动放大。
                </div>
              </Card>
            </>
          ) : <div className="card" style={{ padding: 14 }}>日振幅数据不足：{amp && amp.reason}</div>}
        </>
      )}

      {/* ---------- 形态图鉴 ---------- */}
      {tab === 'pattern' && data && (
        <>
          {data.patterns && data.patterns.ok ? (
            <>
              <Card title={`分时形态自动聚类（共 ${data.patterns.n} 个交易日，K=${data.thresholds.clusterK}）`}>
                <div className="muted" style={{ fontSize: 12 }}>算法对每日分时归一化后 KMeans 聚类；点击「查看示例」看典型分时图，下方可对任意历史日做「形态匹配概率」。</div>
              </Card>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                {data.patterns.clusters.map((c) => (
                  <div key={c.id} className="card" style={{ width: 300, padding: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <b>{c.name}</b><span className="muted">#{c.id}</span>
                    </div>
                    <div className="muted" style={{ fontSize: 12 }}>出现 {c.freq} 次（{c.freqPct}%）· 终值 {c.endPct}%</div>
                    <EChart option={{ grid: { left: 30, right: 10, top: 10, bottom: 20 }, xAxis: { type: 'category', data: c.centroid.map((_, i) => i), show: false }, yAxis: { type: 'value', scale: true, axisLabel: { fontSize: 9 } }, series: [{ type: 'line', data: c.centroid, smooth: true, showSymbol: false, lineStyle: { width: 2 } }] }} height={140} />
                    <button className="btn" style={{ marginTop: 6 }} onClick={() => setExampleDate(c.exampleDate)}>查看示例（{c.exampleDate}）</button>
                  </div>
                ))}
              </div>
              {exampleDate && (
                <Card title={`形态示例：${exampleDate}`}>
                  <IntradayTradeChart code={code} date={exampleDate} height={300} />
                </Card>
              )}
              <Card title="该日分时形态匹配概率">
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                  <select value={matchDate} onChange={(e) => setMatchDate(e.target.value)} style={{ padding: '6px 8px' }}>
                    <option value="">选择历史日…</option>
                    {dates.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                  <button className="btn" onClick={() => onMatch(matchDate)}>计算概率</button>
                  {matchRes && <span className="muted">最接近：{matchRes.bestName}（{(matchRes.bestProb * 100).toFixed(1)}%）</span>}
                </div>
                {matchRes && (
                  <EChart option={{ grid: { left: 40, right: 16, top: 20, bottom: 30 }, tooltip: { trigger: 'axis' }, xAxis: { type: 'category', data: matchRes.probs.map((p) => p.name), axisLabel: { fontSize: 10, interval: 0, rotate: 20 } }, yAxis: { type: 'value', name: '概率', axisLabel: { formatter: (v) => (v * 100).toFixed(0) + '%' } }, series: [{ type: 'bar', data: matchRes.probs.map((p) => p.prob), itemStyle: { color: '#8e44ad' } }] }} height={240} />
                )}
              </Card>
            </>
          ) : <div className="card" style={{ padding: 14 }}>分时形态数据不足：{data.patterns && data.patterns.reason}</div>}
        </>
      )}

      {/* ---------- 顶底分析 ---------- */}
      {tab === 'tb' && (
        <>
          <Card title="分时顶底分析（zigzag + 均价线乖离 + MACD背离）">
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <select value={dayDate} onChange={(e) => { setDayDate(e.target.value); onLoadDay(e.target.value); }} style={{ padding: '6px 8px' }}>
                {dates.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
              <button className="btn" onClick={() => onLoadDay(dayDate)}>加载</button>
              <button className="btn" onClick={onNotify}>🔔 检测今日信号并推送企微</button>
              {day && day.intradayMacd && <span className="muted">分时MACD dif={day.intradayMacd.dif} dea={day.intradayMacd.dea} bar={day.intradayMacd.macd}</span>}
            </div>
          </Card>
          {dayLoading && <div className="muted">加载中…</div>}
          {day && day.ok && (
            <>
              <Card title={`${day.date} 分时图（标记顶/底信号）`}>
                <IntradayTradeChart
                  code={code} date={day.date} height={340}
                  marks={(day.topsBottoms || []).map((s) => ({ time: s.time, price: s.price, type: s.type === 'top' ? 'sell' : 'buy' }))}
                />
              </Card>
              <Card title="顶/底信号明细">
                <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                  <thead><tr style={{ textAlign: 'left' }}><th>时间</th><th>类型</th><th>价格</th><th>乖离%</th><th>背离</th><th>量比</th><th>置信度</th></tr></thead>
                  <tbody>
                    {(day.topsBottoms || []).map((s, i) => (
                      <tr key={i} style={{ borderTop: '1px solid #eee' }}>
                        <td>{s.time}</td>
                        <td style={{ color: s.type === 'top' ? '#e23c3c' : '#27ae60' }}>{s.type === 'top' ? '顶' : '底'}</td>
                        <td>{s.price}</td><td>{s.dev}</td><td>{s.divergence || '—'}</td><td>{s.volRatio}</td>
                        <td>{s.confidence === 'high' ? '🔴高' : s.confidence === 'medium' ? '🟠中' : '⚪低'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {(!day.topsBottoms || !day.topsBottoms.length) && <div className="muted">该日未识别到显著顶/底</div>}
              </Card>
              {day.patternMatch && (
                <Card title="该日形态匹配概率">
                  <div className="muted">最接近：{day.patternMatch.bestName}（{(day.patternMatch.bestProb * 100).toFixed(1)}%）</div>
                  <EChart option={{ grid: { left: 40, right: 16, top: 20, bottom: 30 }, tooltip: { trigger: 'axis' }, xAxis: { type: 'category', data: day.patternMatch.probs.map((p) => p.name), axisLabel: { fontSize: 10, interval: 0, rotate: 20 } }, yAxis: { type: 'value', axisLabel: { formatter: (v) => (v * 100).toFixed(0) + '%' } }, series: [{ type: 'bar', data: day.patternMatch.probs.map((p) => p.prob), itemStyle: { color: '#8e44ad' } }] }} height={220} />
                </Card>
              )}
            </>
          )}
          {day && !day.ok && <div className="card" style={{ padding: 14 }}>{day.reason}</div>}

          {/* ---------- 分时回放（盘中信号 vs 盘后复盘 验证） ---------- */}
          <Card title="🎬 分时回放（验证盘中顶底信号 = 盘后复盘信号）">
            <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
              按 30 秒基准回放全天分时（1×=全天约30秒），逐步揭示盘中算法实时发出的顶/底信号，并与盘后复盘信号逐根比对：已确认信号零撤回，盘尾运行中的极值标记为「待确认」。
            </div>
            {!replay && <div className="muted">该日回放数据加载中或不可用（{day && day.date ? day.date : ''}）。</div>}
            {replay && (
              <>
                {/* 播放控制条 */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 }}>
                  <button className="btn" onClick={() => { setPlaying(false); setRpIndex(0); rpIndexRef.current = 0; }}>⏮ 重置</button>
                  <button className="btn" onClick={() => { setPlaying(false); const v = Math.max(0, rpIndexRef.current - 1); rpIndexRef.current = v; setRpIndex(v); }}>◀ 上一根</button>
                  <button className="btn" style={{ fontWeight: 700, minWidth: 64 }} onClick={() => { if (rpIndexRef.current >= N) { setRpIndex(0); rpIndexRef.current = 0; } setPlaying((p) => !p); }}>
                    {playing ? '⏸ 暂停' : '▶ 播放'}
                  </button>
                  <button className="btn" onClick={() => { setPlaying(false); const v = Math.min(N, rpIndexRef.current + 1); rpIndexRef.current = v; setRpIndex(v); }}>下一根 ▶</button>
                  <span className="muted" style={{ fontSize: 12 }}>速率：</span>
                  {[0.5, 1, 2, 4].map((sp) => (
                    <button key={sp} className="btn" onClick={() => setSpeed(sp)} style={{ fontWeight: speed === sp ? 700 : 400, background: speed === sp ? 'var(--accent)' : '#fff', color: speed === sp ? '#fff' : 'var(--ink)', border: '1px solid ' + (speed === sp ? 'var(--accent)' : 'var(--line)') }}>{sp}×</button>
                  ))}
                  <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>当前 {curTime || '—'} · 已展示 {rpIndex}/{N} 根</span>
                </div>
                {/* 进度条（可拖拽定位） */}
                <input type="range" min={0} max={N} value={rpIndex} onChange={(e) => { setPlaying(false); const v = Number(e.target.value); rpIndexRef.current = v; setRpIndex(v); }} style={{ width: '100%', marginBottom: 10 }} />
                {/* 回放分时图 */}
                {replayOption
                  ? <EChart option={replayOption} height={360} />
                  : <div className="muted" style={{ padding: 20, textAlign: 'center' }}>点击「▶ 播放」或拖动进度条开始回放</div>}
                <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>红 pin = 顶(卖) · 绿三角 = 底(买)；图中标记=当前已发出信号（含未定型）。</div>

                {/* 验证面板 */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 12 }}>
                  <Stat label="已提交信号(=盘后)" value={committed.length + ' / ' + total} sub="算法零撤回" />
                  <Stat label="待确认(未定型)" value={tentative.length} sub="盘尾运行极值" />
                  <Stat label="全天进度" value={reached + ' / ' + total} sub="盘后复盘已发生" />
                  <Stat label="当前播放" value={playing ? '▶ 播放中' : '⏸ 暂停'} />
                </div>
                <div style={{ marginTop: 10, padding: 10, borderRadius: 6, background: allMatched ? '#eafaf1' : '#f6f8fa', border: allMatched ? '1px solid #abebc6' : '1px solid #e5e7eb' }}>
                  {allMatched
                    ? <b style={{ color: '#1e8e3e' }}>✅ 回放至收盘：盘中已提交顶底信号与盘后复盘完全一致（{committed.length}/{total}），算法对已确认信号零撤回。</b>
                    : <span className="muted">⏳ 回放进行中… 已提交 {committed.length} / 全天 {total}（含 {tentative.length} 个未定型极值，将在反转确认后定型或随新高/新低平移）。</span>}
                </div>

                {/* 已提交信号明细 */}
                {committed.length > 0 && (
                  <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse', marginTop: 12 }}>
                    <thead><tr style={{ textAlign: 'left' }}><th>时间</th><th>类型</th><th>价格</th><th>乖离%</th><th>背离</th><th>量比</th><th>置信度</th><th>状态</th></tr></thead>
                    <tbody>
                      {committed.map((s, i) => (
                        <tr key={i} style={{ borderTop: '1px solid #eee' }}>
                          <td>{s.time}</td>
                          <td style={{ color: s.type === 'top' ? '#e23c3c' : '#27ae60' }}>{s.type === 'top' ? '顶' : '底'}</td>
                          <td>{s.price}</td><td>{s.dev}</td><td>{s.divergence || '—'}</td><td>{s.volRatio}</td>
                          <td>{s.confidence === 'high' ? '🔴高' : s.confidence === 'medium' ? '🟠中' : '⚪低'}</td>
                          <td style={{ color: '#1e8e3e' }}>✅ 已提交</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {tentative.length > 0 && (
                  <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>未定型：{tentative.map((s) => (s.type === 'top' ? '顶' : '底') + s.time).join('、')}（盘尾运行中极值，未达反转确认）</div>
                )}
              </>
            )}
          </Card>
        </>
      )}

      {/* ---------- 参考卡 ---------- */}
      {tab === 'ref' && data && (
        <Card title="每日操作参考卡（盘前）">
          {data.reference ? (
            <div>
              <Stat label="预期振幅区间" value={(data.reference.expectedRange ? data.reference.expectedRange.low + '%~' + data.reference.expectedRange.high + '%' : '—')} sub="历史P25~P75" />
              <Stat label="平均振幅" value={(data.reference.amplitudeAvg || '—') + '%'} />
              <Stat label="最大振幅" value={(data.reference.amplitudeMax || '—') + '%'} />
              <Stat label={'近' + (data.thresholds ? data.thresholds.recentDays : 20) + '日高'} value={data.reference.recentHigh || '—'} />
              <Stat label={'近' + (data.thresholds ? data.thresholds.recentDays : 20) + '日低'} value={data.reference.recentLow || '—'} />
              <Stat label="昨收" value={data.reference.lastClose || '—'} />
              {data.reference.cost && <Stat label="持仓成本" value={data.reference.cost} sub="围绕成本做T" />}
              <div style={{ marginTop: 10 }}>
                <div className="muted" style={{ fontSize: 12 }}>日K均线（MA）：{data.reference.ma ? `MA5 ${data.reference.ma.MA5} / MA10 ${data.reference.ma.MA10} / MA20 ${data.reference.ma.MA20} / MA60 ${data.reference.ma.MA60}` : '—'}</div>
                <div className="muted" style={{ fontSize: 12 }}>日K MACD：{data.reference.macd ? `dif ${data.reference.macd.dif} / dea ${data.reference.macd.dea} / bar ${data.reference.macd.macd}` : '—'}</div>
              </div>
              {data.todayPattern && (
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>今日分时形态匹配：{data.todayPattern.bestName}（{(data.todayPattern.bestProb * 100).toFixed(1)}%）</div>
              )}
              <div style={{ marginTop: 8, padding: 10, background: '#f6f8fa', borderRadius: 6 }}>
                <b>信号规则：</b>{data.reference.rule}
              </div>
            </div>
          ) : <div className="muted">暂无参考卡</div>}
        </Card>
      )}

      {/* ---------- 多股对比 ---------- */}
      {tab === 'cmp' && (
        <>
          <Card title="多股票对比（自选股）">
            <button className="btn" onClick={onCompare}>⚖️ 运行对比</button>
          </Card>
          {cmp && cmp.ok && (
            <Card title="对比结果">
              <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                <thead><tr style={{ textAlign: 'left' }}><th>代码</th><th>平均振幅</th><th>P75</th><th>最大</th><th>波动倍数</th><th>主形态</th><th>主形态占比</th><th>顶底密度/日</th></tr></thead>
                <tbody>
                  {cmp.rows.map((r, i) => (
                    <tr key={i} style={{ borderTop: '1px solid #eee' }}>
                      <td>{r.code}</td>
                      <td>{r.ampAvg != null ? r.ampAvg + '%' : '—'}</td>
                      <td>{r.ampP75 != null ? r.ampP75 + '%' : '—'}</td>
                      <td>{r.ampMax != null ? r.ampMax + '%' : '—'}</td>
                      <td>{r.benchRatio != null ? r.benchRatio + '×' : '—'}</td>
                      <td>{r.dominant || '—'}</td>
                      <td>{r.dominantPct != null ? r.dominantPct + '%' : '—'}</td>
                      <td>{r.tbDensity != null ? r.tbDensity : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </>
      )}

      {/* ---------- 阈值配置 ---------- */}
      {tab === 'th' && (
        <Card title="阈值配置（保存后重新计算）">
          {th && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, maxWidth: 520 }}>
              {[
                ['revPct', 'zigzag反转阈值%'], ['devThresh', '均线乖离阈值%'], ['minBars', '拐点最小根数'],
                ['clusterK', '形态聚类数K'], ['featureLen', '特征向量长度'], ['ampRangeLowPct', '振幅区间下分位%'],
                ['ampRangeHighPct', '振幅区间上分位%'], ['recentDays', '趋势/支撑窗口'],
              ].map(([k, label]) => (
                <div key={k}>
                  <div className="muted" style={{ fontSize: 12 }}>{label}</div>
                  <input type="number" value={th[k]} onChange={(e) => setTh({ ...th, [k]: Number(e.target.value) })} style={{ padding: '6px 8px', width: '100%' }} />
                </div>
              ))}
              <div>
                <div className="muted" style={{ fontSize: 12 }}>推送最低置信度</div>
                <select value={th.notifyMinConfidence} onChange={(e) => setTh({ ...th, notifyMinConfidence: e.target.value })} style={{ padding: '6px 8px', width: '100%' }}>
                  <option value="high">高</option><option value="medium">中</option><option value="low">低</option>
                </select>
              </div>
            </div>
          )}
          <button className="btn" style={{ marginTop: 12 }} onClick={onSaveTh}>💾 保存阈值</button>
        </Card>
      )}

      {/* ---------- 回测验证 ---------- */}
      {tab === 'bt' && (
        <>
          <Card title="回测验证（高置信顶/底信号做T）">
            <button className="btn" onClick={onBacktest}>🧪 运行回测</button>
          </Card>
          {bt && bt.ok && (
            <Card title="回测结果">
              <Stat label="交易日" value={bt.days} />
              <Stat label="有信号日" value={bt.daysWithSignals} />
              <Stat label="交易次数" value={bt.trades} />
              <Stat label="胜率" value={bt.winRate + '%'} />
              <Stat label="单次均收益" value={bt.avgRet + '%'} />
              <Stat label="累计收益" value={bt.totalRet + '%'} />
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>逻辑（理论回测·含后见之明）：每个有信号日，将相邻的「底拐点」与下一「顶拐点」配对（当日高抛低吸），仅统计含显著锚点的交易对。该结果验证分时具备均值回归结构，但并非实时可交易模拟（实时需结合盘中信号触发）。</div>
            </Card>
          )}
          {bt && !bt.ok && <div className="card" style={{ padding: 14 }}>{bt.reason}</div>}
        </>
      )}
    </div>
  );
}
