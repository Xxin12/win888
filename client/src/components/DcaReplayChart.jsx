import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts';

// 定投回测 · 时间轴动画回放
// 性能要点: 组件自持 echarts 实例与帧循环, 每帧只切片 series.data 并用 lazyUpdate 增量渲染;
// 指标卡/进度条/日期标签用 ref 直接改 DOM, 不触发 React 重渲染 -> 稳定 20fps。
const UP = '#e23c3c', DOWN = '#1aa260';
const COST = '#ff8f1f', INV = '#9aa0a6';
const FPS = 20, TICK = 1000 / FPS, TARGET_SEC = 45; // 1x 速度下全程约 45 秒
const SPEEDS = [0.5, 1, 2, 4, 8];

const money = (v) => (v == null ? '--' : '¥' + Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 0 }));
const pct = (v) => (v == null ? '--' : (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%');

export default function DcaReplayChart({ result, height = 380 }) {
  const tl = (result && result.timeline) || [];
  const N = tl.length;
  const boxRef = useRef(null);
  const chartRef = useRef(null);
  const idxRef = useRef(0);
  const timerRef = useRef(null);
  const rangeRef = useRef(null);
  const dateRef = useRef(null);
  const cellRefs = useRef({});
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [mode, setMode] = useState('full'); // full=全景 | pan=跟随窗口
  const [done, setDone] = useState(false);

  // ---- 预计算全量序列(仅在结果变化时重算) ----
  const data = useMemo(() => {
    const dates = new Array(N), kline = new Array(N), closes = new Array(N);
    const costs = new Array(N), invs = new Array(N), mvs = new Array(N), pls = new Array(N);
    const buys = [], sells = [], divs = [];
    let maxAmt = 1;
    for (let i = 0; i < N; i++) {
      const t = tl[i];
      dates[i] = t.d;
      kline[i] = [t.o, t.c, t.l, t.h];
      closes[i] = t.c;
      costs[i] = t.cost > 0 ? t.cost : null;
      invs[i] = t.inv;
      mvs[i] = t.mv;
      pls[i] = t.pl;
      if (t.buy) { buys.push({ i, v: t.buy.price, b: t.buy }); if (t.buy.amount > maxAmt) maxAmt = t.buy.amount; }
      if (t.sell) sells.push({ i, v: t.sell.price, s: t.sell });
      if (t.div) divs.push({ i, cash: t.div.cash, bonus: t.div.bonus, transfer: t.div.transfer, cashShares: t.div.cashShares, bonusShares: t.div.bonusShares, sharesAfter: t.div.sharesAfter });
    }
    return { dates, kline, closes, costs, invs, mvs, pls, buys, sells, divs, maxAmt };
  }, [result]);

  const step = Math.max(1, Math.ceil(N / (TARGET_SEC * FPS)));

  // ---- 初始化图表 ----
  useEffect(() => {
    if (!boxRef.current) return;
    const c = echarts.init(boxRef.current);
    chartRef.current = c;
    const onResize = () => { try { c.resize(); } catch (_) {} };
    window.addEventListener('resize', onResize);
    let ro;
    try {
      if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(onResize); ro.observe(boxRef.current); }
    } catch (_) {}
    return () => {
      window.removeEventListener('resize', onResize);
      try { ro && ro.disconnect(); } catch (_) {}
      try { c.dispose(); } catch (_) {}
      chartRef.current = null;
    };
  }, []);

  // ---- 结果或模式变化: 重建骨架并回到起点 ----
  useEffect(() => {
    if (!chartRef.current || !N) return;
    chartRef.current.setOption(baseOption(data, mode, height), true);
    stop();
    idxRef.current = 0;
    setDone(false);
    render(0);
  }, [result, mode]);

  // ---- 渲染某一帧 ----
  const render = (i) => {
    const c = chartRef.current;
    if (!c || !N) return;
    const n = Math.max(1, Math.min(i, N));
    const t = tl[n - 1];
    const useCandle = mode === 'pan';
    const priceData = useCandle ? data.kline.slice(0, n) : data.closes.slice(0, n);

    let bCount = 0;
    while (bCount < data.buys.length && data.buys[bCount].i < n) bCount++;
    let sCount = 0;
    while (sCount < data.sells.length && data.sells[sCount].i < n) sCount++;
    const buyPts = data.buys.slice(0, bCount).map((x) => [x.i, x.v, x.b.amount, x.b.mul, x.b.shares]);
    const sellPts = data.sells.slice(0, sCount).map((x) => [x.i, x.v, x.s.amount, 0, x.s.shares]);
    let dCount = 0;
    while (dCount < data.divs.length && data.divs[dCount].i < n) dCount++;
    const divPts = data.divs.slice(0, dCount).map((x) => [x.i, data.closes[x.i], x.cash, x.bonus, x.transfer, x.sharesAfter]);

    const gain = t.pl >= 0;
    const opt = {
      series: [
        { data: priceData },
        { data: data.costs.slice(0, n) },
        { data: buyPts },
        { data: sellPts },
        { data: divPts },
        { data: data.invs.slice(0, n) },
        { data: data.mvs.slice(0, n), itemStyle: { color: gain ? UP : DOWN }, areaStyle: { color: gain ? 'rgba(226,60,60,.16)' : 'rgba(26,162,96,.16)' }, lineStyle: { color: gain ? UP : DOWN } },
      ],
    };
    if (mode === 'pan') {
      const win = 250;
      opt.dataZoom = [{ startValue: Math.max(0, n - win), endValue: n - 1 }, { startValue: Math.max(0, n - win), endValue: n - 1 }];
    }
    c.setOption(opt, { lazyUpdate: true });

    // 指标卡 / 进度条 / 日期: 直接写 DOM
    const set = (k, txt, cls) => {
      const el = cellRefs.current[k];
      if (!el) return;
      if (el.textContent !== txt) el.textContent = txt;
      if (cls != null && el.className !== 'v ' + cls) el.className = 'v ' + cls;
    };
    set('inv', money(t.inv));
    set('mv', money(t.mv));
    set('pl', money(t.pl), t.pl > 0 ? 'up' : t.pl < 0 ? 'down' : '');
    set('ret', pct(t.ret), t.ret > 0 ? 'up' : t.ret < 0 ? 'down' : '');
    set('cost', t.cost > 0 ? '¥' + t.cost.toFixed(3) : '--');
    set('sh', t.sh ? Number(t.sh).toLocaleString('zh-CN') : '0');
    set('px', '¥' + Number(t.c).toFixed(2));
    if (dateRef.current) dateRef.current.textContent = t.d + '　(' + n + '/' + N + ')';
    if (rangeRef.current && Number(rangeRef.current.value) !== n) rangeRef.current.value = String(n);
  };

  // ---- 播放控制 ----
  const stop = () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };

  useEffect(() => {
    stop();
    if (!playing || !N) return;
    timerRef.current = setInterval(() => {
      const next = idxRef.current + Math.max(1, Math.round(step * speed));
      if (next >= N) {
        idxRef.current = N; render(N);
        setPlaying(false); setDone(true);
      } else { idxRef.current = next; render(next); }
    }, TICK);
    return stop;
  }, [playing, speed, N, step, mode]);

  useEffect(() => () => stop(), []);

  const onPlay = () => {
    if (idxRef.current >= N) { idxRef.current = 0; setDone(false); render(0); }
    setPlaying((v) => !v);
  };
  const onStep = () => {
    setPlaying(false);
    const next = Math.min(N, idxRef.current + 1);
    idxRef.current = next; render(next);
  };
  const onReset = () => { setPlaying(false); setDone(false); idxRef.current = 0; render(0); };
  const onSeek = (e) => {
    setPlaying(false);
    const v = Math.max(0, Math.min(N, Number(e.target.value)));
    idxRef.current = v; render(v); setDone(v >= N);
  };

  if (!N) return <div className="muted">无回放数据</div>;

  const M = [
    { k: 'inv', t: '累计投入' }, { k: 'mv', t: '持仓市值' }, { k: 'pl', t: '浮动盈亏' },
    { k: 'ret', t: '收益率' }, { k: 'cost', t: '持仓成本' }, { k: 'sh', t: '持股数' }, { k: 'px', t: '当日收盘' },
  ];

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <button className="btn primary" onClick={onPlay}>{playing ? '⏸ 暂停' : (done ? '↻ 重新播放' : '▶ 播放')}</button>
        <button className="btn" onClick={onStep}>⏭ 单步</button>
        <button className="btn" onClick={onReset}>⏮ 重置</button>
        <span className="muted" style={{ marginLeft: 6 }}>速度</span>
        {SPEEDS.map((s) => (
          <button key={s} className={'btn ' + (speed === s ? 'primary' : '')} style={{ padding: '4px 8px' }} onClick={() => setSpeed(s)}>{s}×</button>
        ))}
        <span className="muted" style={{ marginLeft: 6 }}>视图</span>
        <button className={'btn ' + (mode === 'full' ? 'primary' : '')} style={{ padding: '4px 8px' }} onClick={() => setMode('full')}>全景</button>
        <button className={'btn ' + (mode === 'pan' ? 'primary' : '')} style={{ padding: '4px 8px' }} onClick={() => setMode('pan')}>跟随K线</button>
        <span ref={dateRef} style={{ marginLeft: 'auto', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }} />
      </div>

      <input ref={rangeRef} type="range" min={0} max={N} defaultValue={0} onChange={onSeek}
        style={{ width: '100%', margin: '0 0 10px', accentColor: UP }} />

      <div className="row" style={{ marginBottom: 8 }}>
        {M.map((m) => (
          <div className="metric" key={m.k}>
            <div className="k">{m.t}</div>
            <div className="v" ref={(el) => { cellRefs.current[m.k] = el; }}>--</div>
          </div>
        ))}
      </div>

      <div ref={boxRef} style={{ width: '100%', height }} />
      <div className="muted" style={{ marginTop: 4 }}>
        🔴 买点（圆点大小 = 该期投入金额）　🟢 止盈卖点　🟠 红利再投（菱形）　<span style={{ color: COST }}>━ 橙色虚线 = 摊薄持仓成本</span>　
        下方：灰色 = 累计投入，红/绿 = 持仓市值（高于投入为红）
      </div>
    </div>
  );
}

// ---- 图表骨架(仅在结果/模式变化时重建) ----
function baseOption(data, mode, height) {
  const useCandle = mode === 'pan';
  const maxAmt = data.maxAmt || 1;
  const g1H = Math.round(height * 0.58);
  return {
    animation: false,
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'cross' }, confine: true,
      formatter: (ps) => {
        if (!ps || !ps.length) return '';
        const i = ps[0].dataIndex;
        let s = '<b>' + data.dates[i] + '</b>';
        for (const p of ps) {
          if (p.seriesName === '买入') {
            s += '<br/>🔴 买入 ¥' + p.value[1] + ' × ' + Number(p.value[4]).toLocaleString() +
              ' 股 = ' + Math.round(p.value[2]).toLocaleString() + ' 元' + (p.value[3] !== 1 ? '（' + p.value[3] + '× 加码）' : '');
          } else if (p.seriesName === '止盈卖出') {
            s += '<br/>🟢 止盈卖出 ¥' + p.value[1] + ' × ' + Number(p.value[4]).toLocaleString() + ' 股';
          } else if (p.seriesName === '红利再投') {
            s += '<br/>🟠 红利再投 ' + data.dates[p.dataIndex] + '：每股派息 ¥' + p.value[2] +
              '，送股 ' + p.value[3] + '，转增 ' + p.value[4] + '；再投后持股 ' + Number(p.value[5]).toLocaleString() + ' 股';
          } else if (p.value != null) {
            const v = Array.isArray(p.value) ? p.value[1] : p.value;
            if (v != null) s += '<br/>' + p.marker + p.seriesName + '：' + (typeof v === 'number' ? v.toLocaleString('zh-CN', { maximumFractionDigits: 3 }) : v);
          }
        }
        return s;
      },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: [
      { left: 58, right: 58, top: 16, height: g1H },
      { left: 58, right: 58, top: g1H + 52, bottom: 44 },
    ],
    xAxis: [
      { type: 'category', data: data.dates, gridIndex: 0, boundaryGap: useCandle, axisLabel: { show: false }, axisLine: { lineStyle: { color: '#ddd' } }, axisTick: { show: false } },
      { type: 'category', data: data.dates, gridIndex: 1, boundaryGap: useCandle, axisLine: { lineStyle: { color: '#ddd' } }, axisLabel: { fontSize: 11, color: '#888' } },
    ],
    yAxis: [
      { scale: true, gridIndex: 0, splitLine: { lineStyle: { color: '#f0f0f0' } }, axisLabel: { fontSize: 11, color: '#888', formatter: (v) => (v >= 1 ? v.toFixed(2) : v.toFixed(3)) } },
      { scale: true, gridIndex: 1, splitLine: { lineStyle: { color: '#f0f0f0' } }, axisLabel: { fontSize: 11, color: '#888', formatter: (v) => (Math.abs(v) >= 10000 ? (v / 10000).toFixed(0) + '万' : v) } },
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1], start: 0, end: 100, zoomLock: mode === 'pan' },
      { type: 'slider', xAxisIndex: [0, 1], start: 0, end: 100, bottom: 8, height: 16, show: mode === 'full' },
    ],
    series: [
      useCandle
        ? { name: '价格', type: 'candlestick', xAxisIndex: 0, yAxisIndex: 0, data: [], itemStyle: { color: UP, color0: DOWN, borderColor: UP, borderColor0: DOWN }, large: true }
        : { name: '收盘价', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: [], showSymbol: false, lineStyle: { width: 1.4, color: '#5a6270' }, sampling: 'lttb' },
      { name: '持仓成本', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: [], showSymbol: false, connectNulls: true, lineStyle: { width: 1.6, color: COST, type: 'dashed' } },
      {
        name: '买入', type: 'scatter', xAxisIndex: 0, yAxisIndex: 0, data: [], z: 10,
        symbolSize: (v) => 5 + Math.sqrt((v[2] || 0) / maxAmt) * 11,
        itemStyle: { color: 'rgba(226,60,60,.85)', borderColor: '#fff', borderWidth: 0.5 },
      },
      {
        name: '止盈卖出', type: 'scatter', xAxisIndex: 0, yAxisIndex: 0, data: [], z: 11,
        symbol: 'triangle', symbolSize: 11, itemStyle: { color: DOWN, borderColor: '#fff', borderWidth: 0.5 },
      },
      {
        name: '红利再投', type: 'scatter', xAxisIndex: 0, yAxisIndex: 0, data: [], z: 9,
        symbol: 'diamond', symbolSize: 9, itemStyle: { color: '#ffb300', borderColor: '#fff', borderWidth: 0.5 },
      },
      { name: '累计投入', type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: [], showSymbol: false, step: 'end', lineStyle: { width: 1.2, color: INV }, areaStyle: { color: 'rgba(154,160,166,.22)' }, sampling: 'lttb' },
      { name: '持仓市值', type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: [], showSymbol: false, lineStyle: { width: 1.5, color: UP }, areaStyle: { color: 'rgba(226,60,60,.16)' }, sampling: 'lttb' },
    ],
  };
}
