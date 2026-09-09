import React, { useEffect, useRef } from 'react';
import * as echarts from 'echarts';

// 通用 ECharts 容器 (容错: 初始化/渲染异常不影响整页)
// instanceRef: 可选, 外部 ref, 初始化后写入 echarts 实例(用于截图 getDataURL)
export default function Chart({ option, height = 320, style, instanceRef }) {
  const ref = useRef(null);
  const inst = useRef(null);
  const zoomRef = useRef(null); // 记录用户当前缩放范围, 避免重渲染被重置

  // 安全初始化: 容器存在才 init
  const ensureInit = () => {
    if (inst.current) return true;
    const el = ref.current;
    if (!el) return false;
    try {
      inst.current = echarts.init(el);
      if (instanceRef && typeof instanceRef === 'object') instanceRef.current = inst.current;
      // 监听用户缩放, 记录范围(事件仅在图表渲染后由用户交互触发, 此时 getOption 安全)
      inst.current.on('datazoom', () => {
        try {
          const opt = inst.current.getOption();
          const dz = opt.dataZoom && opt.dataZoom[0];
          if (dz && dz.start != null) zoomRef.current = { start: dz.start, end: dz.end };
        } catch (_) { /* ignore */ }
      });
      return true;
    } catch (e) {
      console.error('[Chart] echarts.init 失败:', e);
      return false;
    }
  };

  useEffect(() => {
    ensureInit();
    const onResize = () => { try { inst.current && inst.current.resize(); } catch (_) {} };
    window.addEventListener('resize', onResize);
    // 初次布局可能未完成, 下一帧再 resize 一次
    const t = setTimeout(() => { try { inst.current && inst.current.resize(); } catch (_) {} }, 60);
    // 监听容器尺寸变化(移动端布局变化/旋转/导航吸顶导致宽度变化时自动 resize)
    let ro;
    try {
      if (typeof ResizeObserver !== 'undefined' && ref.current) {
        ro = new ResizeObserver(() => { try { inst.current && inst.current.resize(); } catch (_) {} });
        ro.observe(ref.current);
      }
    } catch (_) { /* ignore */ }
    return () => {
      window.removeEventListener('resize', onResize);
      clearTimeout(t);
      try { ro && ro.disconnect(); } catch (_) {}
      try { inst.current && inst.current.dispose(); } catch (_) {}
      inst.current = null;
      if (instanceRef && typeof instanceRef === 'object') instanceRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!option) return;
    if (!ensureInit()) return;
    try {
      const chart = inst.current;
      let next = option;
      // 仅在用户缩放过(实例已成功 setOption)时才保留范围; 绝不在 setOption 前调 getOption
      if (zoomRef.current) {
        next = { ...option, dataZoom: (option.dataZoom || []).map((d, i) => (i === 0 ? { ...d, ...zoomRef.current } : d)) };
      }
      chart.setOption(next, true);
    } catch (e) {
      console.error('[Chart] setOption 失败(已忽略, 不影响其他组件):', e);
    }
  }, [option]);

  return <div ref={ref} style={{ width: '100%', height, ...style }} />;
}

const UP = '#e23c3c', DOWN = '#1aa260';
const SUB_TITLE = { fontSize: 11, color: '#9aa0a6', fontWeight: 'normal' };

// K线图 option 构造 (蜡烛+成交量+MA叠加, 可选MACD/KDJ/BOLL子图)
// opts.fullDates: 仅实时看盘K线使用, 让底部日期轴按可视范围计算合理间隔(约6个标签),
//   并隐藏重叠标签、给底部留出空间, 避免日期显示过疏/重叠/被裁切。其他页面(如企微)保持原样。
export function klineOption(bars, ind, sub, opts = {}) {
  const fullDates = !!opts.fullDates;
  const cats = bars.map((b) => b.date || b.datetime);
  // 默认 dataZoom 显示后 40%, 据此推算间隔使可视区内约显示 6 个日期标签
  const labelInterval = Math.max(0, Math.floor((cats.length * 0.4) / 6));
  const bottomLabel = fullDates
    ? { fontSize: 10, interval: labelInterval, hideOverlap: true }
    : { fontSize: 10 };
  const kdata = bars.map((b) => [b.open, b.close, b.low, b.high]);
  const vol = bars.map((b, i) => ({ value: b.volume, itemStyle: { color: b.close >= b.open ? UP : DOWN } }));
  const series = [
    { name: 'K线', type: 'candlestick', data: kdata,
      itemStyle: { color: UP, color0: DOWN, borderColor: UP, borderColor0: DOWN } },
  ];
  const legend = ['K线'];
  if (ind && ind.MA) {
    Object.entries(ind.MA).forEach(([k, arr], i) => {
      series.push({ name: k, type: 'line', data: arr, smooth: true, showSymbol: false, lineWidth: 1,
        lineStyle: { width: 1 }, xAxisIndex: 0, yAxisIndex: 0 });
      legend.push(k);
    });
  }
  if (ind && ind.BOLL && sub === 'BOLL') {
    ['up', 'mid', 'low'].forEach((k) => {
      series.push({ name: 'BOLL.' + k, type: 'line', data: ind.BOLL[k], showSymbol: false, lineStyle: { width: 1, type: k === 'mid' ? 'solid' : 'dashed', color: '#8b5cf6' } });
    });
  }

  // BOLL 模式主图即底部图, fullDates 时压缩主图高度给日期标签留白(避免裁切); 其余模式主图固定 52%
  const grids = [{ left: 50, right: 20, top: 30, height: sub === 'BOLL' ? (fullDates ? '66%' : '70%') : '52%' }];
  const xAxes = [{
    type: 'category', data: cats, gridIndex: 0, scale: true, boundaryGap: true,
    axisLabel: sub === 'BOLL'
      ? { show: true, ...(fullDates ? bottomLabel : { fontSize: 10 }) }
      : { show: false, fontSize: 10 },
  }];
  const yAxes = [{ scale: true, gridIndex: 0, axisLabel: { fontSize: 10 }, splitLine: { lineStyle: { color: '#f0f0f0' } } }];

  // 成交量子图
  grids.push({ left: 50, right: 20, top: sub && sub !== 'BOLL' ? '66%' : '78%', height: sub && sub !== 'BOLL' ? '14%' : '16%' });
  xAxes.push({ type: 'category', data: cats, gridIndex: 1, axisLabel: { show: false } });
  yAxes.push({ gridIndex: 1, axisLabel: { show: false }, splitLine: { show: false } });
  series.push({ name: '成交量', type: 'bar', data: vol, xAxisIndex: 1, yAxisIndex: 1 });

  // 指标子图 MACD/KDJ (ind 可能尚未加载/为 null, 必须先把 ind 判空放最前短路)
  if (ind && ind.MACD && sub === 'MACD') {
    // fullDates 时把底部子图整体上移, 给日期标签留出空间(避免裁切)
    grids.push({ left: 50, right: 20, top: fullDates ? '82%' : '84%', height: '13%' });
    xAxes.push({ type: 'category', data: cats, gridIndex: 2, axisLabel: bottomLabel });
    yAxes.push({ gridIndex: 2, axisLabel: { fontSize: 10 }, splitLine: { show: false } });
    series.push({ name: 'MACD', type: 'bar', data: ind.MACD.macd.map((v) => ({ value: v, itemStyle: { color: v >= 0 ? UP : DOWN } })), xAxisIndex: 2, yAxisIndex: 2 });
    series.push({ name: 'DIF', type: 'line', data: ind.MACD.dif, xAxisIndex: 2, yAxisIndex: 2, showSymbol: false, lineStyle: { width: 1, color: '#f59e0b' } });
    series.push({ name: 'DEA', type: 'line', data: ind.MACD.dea, xAxisIndex: 2, yAxisIndex: 2, showSymbol: false, lineStyle: { width: 1, color: '#3b82f6' } });
  }
  if (ind && ind.KDJ && sub === 'KDJ') {
    grids.push({ left: 50, right: 20, top: fullDates ? '82%' : '84%', height: '13%' });
    xAxes.push({ type: 'category', data: cats, gridIndex: 2, axisLabel: bottomLabel });
    yAxes.push({ gridIndex: 2, axisLabel: { fontSize: 10 }, splitLine: { show: false } });
    ['K', 'D', 'J'].forEach((k, i) => series.push({ name: k, type: 'line', data: ind.KDJ[k], xAxisIndex: 2, yAxisIndex: 2, showSymbol: false, lineStyle: { width: 1, color: ['#f59e0b', '#3b82f6', '#8b5cf6'][i] } }));
  }

  // 各子面板标题(说明名称), 避免只看图标不知是哪一类; 与对应子图渲染条件保持一致
  const volTop = sub && sub !== 'BOLL' ? '64%' : '76%';
  const titles = [
    { text: '成交量', left: 50, top: volTop, textStyle: SUB_TITLE },
  ];
  if (sub === 'MACD' && ind && ind.MACD) titles.push({ text: 'MACD (DIF 快线 / DEA 慢线, 金叉看两线交叉)', left: 50, top: '82%', textStyle: SUB_TITLE });
  if (sub === 'KDJ' && ind && ind.KDJ) titles.push({ text: 'KDJ (K/D/J 三线, >80 超买 <20 超卖)', left: 50, top: '82%', textStyle: SUB_TITLE });
  if (sub === 'BOLL' && ind && ind.BOLL) titles.push({ text: 'BOLL 上下轨叠加 (中轨=MA20)', left: 50, top: 4, textStyle: SUB_TITLE });

  return {
    animation: false,
    title: titles,
    legend: { data: legend, top: 4, fontSize: 11 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: grids, xAxis: xAxes, yAxis: yAxes,
    dataZoom: [{ type: 'inside', xAxisIndex: xAxes.map((_, i) => i), start: 60, end: 100 }],
    series,
  };
}

// 做T分析·分时顶底标记: 顶=红pin(卖) 底=绿三角(买), 叠加到价格主图。
// yOf(price) 把绝对价映射到当前主图坐标(绝对价模式=原价; 大盘叠加模式=涨跌幅%)。
function tbMarkPoint(marks, yOf) {
  if (!marks || !marks.length) return undefined;
  return {
    symbol: 'pin',
    data: marks.map((m) => {
      const top = m.type === 'top';
      const y = yOf(m.price);
      return {
        name: top ? '顶' : '底',
        coord: [m.time, y],
        symbol: top ? 'pin' : 'triangle',
        symbolSize: top ? 42 : 28,
        symbolOffset: [0, top ? -12 : 10],
        itemStyle: { color: top ? '#e23c3c' : '#1aa260' },
        label: {
          show: true,
          formatter: (top ? '顶 ' : '底 ') + Number(m.price).toFixed(2),
          fontSize: 9, fontWeight: 'bold', color: '#fff',
          backgroundColor: top ? '#e23c3c' : '#1aa260',
          padding: [1, 3], borderRadius: 2,
        },
      };
    }),
  };
}

// 分时 MACD(12,26,9): 基于每分钟收盘价序列的 EMA 差值(分时级 MACD)
// 算法：EMA(fast) − EMA(slow) = DIF；DIF 的 EMA(signal) = DEA；MACD 柱 = 2×(DIF − DEA)。
// 注意：DEA 必须以「首根 DIF 值」(≈0) 为起点做 EMA, 绝不能拿首根价格(≈5.x)当种子,
// 否则 DEA 会从价格量级缓慢衰减, MACD 柱在开盘初被放到 ±8 级别的离谱值(振幅异常)。
function macdFromPrices(prices, fast = 12, slow = 26, signal = 9) {
  const n = prices.length;
  if (!n) return { dif: [], dea: [], macd: [] };
  const k1 = 2 / (fast + 1), k2 = 2 / (slow + 1), k3 = 2 / (signal + 1);
  const dif = new Array(n), dea = new Array(n), macd = new Array(n);
  let pf = prices[0], ps = prices[0];
  for (let i = 0; i < n; i++) {
    pf = prices[i] * k1 + pf * (1 - k1);
    ps = prices[i] * k2 + ps * (1 - k2);
    dif[i] = pf - ps;
  }
  let pd = dif[0]; // 关键: DEA 种子 = 首根 DIF(≈0), 而非首根价格
  for (let i = 0; i < n; i++) {
    pd = dif[i] * k3 + pd * (1 - k3);
    dea[i] = pd;
    macd[i] = (dif[i] - dea[i]) * 2;
  }
  return { dif, dea, macd };
}

// 分时副图(共用): 通达信日内T指标 (空方力度/多方力度/RSI/主力吸筹 + 参考线 + 信号点)
// 直接追加到第 grids.length 个 grid, 内部捕获实际 gridIndex / xAxisIndex / yAxisIndex, 同时适配
// 「价格+振幅%双轴」(y 轴多一个右轴) 与「绝对价 / 大盘叠加」(一轴) 两种情形。
function appendIntradayT(grids, xAxes, yAxes, series, titles, cats, intra, left, right, topPct, hPct) {
  const gi = grids.length;
  const yi = yAxes.length;
  grids.push({ left, right, top: topPct, height: hPct });
  xAxes.push({ type: 'category', data: cats, gridIndex: gi, axisLabel: { fontSize: 9, interval: 40 } });
  yAxes.push({ gridIndex: gi, min: 0, max: 110, axisLabel: { fontSize: 9 }, splitLine: { show: false } });
  const markLine = {
    silent: true, symbol: 'none', lineStyle: { type: 'dotted' },
    data: [
      { yAxis: 0, lineStyle: { color: '#e23c3c' } },
      { yAxis: 44, lineStyle: { color: '#999999' } },
      { yAxis: 90, lineStyle: { color: '#3b82f6' } },
    ],
  };
  const sig = [];
  intra.signals.多方上穿.forEach((v, i) => { if (v) sig.push({ value: [i, 33], symbol: 'triangle', symbolSize: 9, itemStyle: { color: '#1aa260' } }); });
  intra.signals.rsiDown.forEach((v, i) => { if (v) sig.push({ value: [i, 92], symbol: 'circle', symbolSize: 7, itemStyle: { color: '#e23c3c' } }); });
  intra.signals.var5.forEach((v, i) => { if (v) sig.push({ value: [i, 6], symbol: 'pin', symbolSize: 16, itemStyle: { color: '#1aa260' }, label: { show: true, formatter: '底', fontSize: 8, color: '#fff' } }); });
  intra.signals.var6.forEach((v, i) => { if (v) sig.push({ value: [i, 104], symbol: 'pin', symbolSize: 16, itemStyle: { color: '#e23c3c' }, label: { show: true, formatter: '顶', fontSize: 8, color: '#fff' } }); });
  intra.signals.持币信号.forEach((v, i) => { if (v) sig.push({ value: [i, 44], symbol: 'diamond', symbolSize: 7, itemStyle: { color: '#06b6d4' } }); });
  series.push({ name: '空方力度', type: 'line', xAxisIndex: gi, yAxisIndex: yi, data: intra.空方力度, showSymbol: false, lineStyle: { width: 1, color: '#1aa260' }, tooltip: { show: false } });
  series.push({ name: '多方力度', type: 'line', xAxisIndex: gi, yAxisIndex: yi, data: intra.多方力度, showSymbol: false, lineStyle: { width: 2, color: '#e23c3c' }, markLine, tooltip: { show: false } });
  series.push({ name: 'RSI', type: 'line', xAxisIndex: gi, yAxisIndex: yi, data: intra.RSI, showSymbol: false, lineStyle: { width: 1, type: 'dashed', color: '#3b82f6' }, tooltip: { show: false } });
  series.push({ name: '主力吸筹', type: 'bar', xAxisIndex: gi, yAxisIndex: yi, data: intra.主力吸筹.map((v) => ({ value: v, itemStyle: { color: 'rgba(245,158,11,.45)' } })), tooltip: { show: false } });
  series.push({ name: '信号', type: 'scatter', xAxisIndex: gi, yAxisIndex: yi, data: sig, z: 5, tooltip: { show: false } });
  titles.push({ text: '日内T指标 ▸ 多方力度(红) · 空方力度(绿) · RSI(蓝虚) · 主力吸筹(黄柱) · 0/44/90参考线', left, top: (parseFloat(topPct) - 2) + '%', textStyle: SUB_TITLE });
}

// 分时副图(共用): MACD (柱=DIF-DEA, DIF 快线, DEA 慢线)；与 K 线 MACD 子图同名以便对照
function appendIntradayMacd(grids, xAxes, yAxes, series, titles, cats, prices, left, right, topPct, hPct) {
  const gi = grids.length;
  const yi = yAxes.length;
  grids.push({ left, right, top: topPct, height: hPct });
  xAxes.push({ type: 'category', data: cats, gridIndex: gi, axisLabel: { fontSize: 9, interval: 40 } });
  yAxes.push({ gridIndex: gi, axisLabel: { fontSize: 9 }, splitLine: { show: false } });
  const m = macdFromPrices(prices);
  series.push({ name: 'MACD', type: 'bar', data: m.macd.map((v) => ({ value: v, itemStyle: { color: v >= 0 ? UP : DOWN } })), xAxisIndex: gi, yAxisIndex: yi, tooltip: { show: false } });
  series.push({ name: 'DIF', type: 'line', data: m.dif, xAxisIndex: gi, yAxisIndex: yi, showSymbol: false, lineStyle: { width: 1, color: '#f59e0b' }, tooltip: { show: false } });
  series.push({ name: 'DEA', type: 'line', data: m.dea, xAxisIndex: gi, yAxisIndex: yi, showSymbol: false, lineStyle: { width: 1, color: '#3b82f6' }, tooltip: { show: false } });
  titles.push({ text: 'MACD (DIF 快线 / DEA 慢线, 金叉看两线交叉)', left, top: (parseFloat(topPct) - 2) + '%', textStyle: SUB_TITLE });
}

// 分时图 option (主图价格 + 成交量 + 通达信日内T指标副图)
// opts.cmp (可选): 大盘指数叠加模式 { index:{name,available}, stock:{prevClose, points:[{t,pct,ipct}]} }
//   - 主图改为"涨跌幅%"双线(个股 / 大盘), 纵坐标以昨收=0 为中心(整幅0为中心点)
//   - 不传 opts.cmp 时(如企微页 Wecom)保持原"绝对价"渲染, 行为不变
export function minuteOption(data, intra, opts = {}) {
  if (opts.cmp && opts.cmp.stock && opts.cmp.stock.points && opts.cmp.stock.points.length) {
    return minuteCompareOption(data, intra, opts.cmp, opts.topsBottoms);
  }
  const cats = data.map((d) => d.t);
  const prices = data.map((d) => d.price);
  const avgs = data.map((d) => d.avg);
  const grids = [
    { left: 50, right: 20, top: 24, height: '45%' },   // 价格主图
    { left: 50, right: 20, top: '52%', height: '9%' }, // 成交量
  ];
  const xAxes = [
    { type: 'category', data: cats, axisLabel: { fontSize: 10, interval: 30 } },
    { type: 'category', data: cats, gridIndex: 1, axisLabel: { show: false } },
  ];
  const yAxes = [
    { scale: true, axisLabel: { fontSize: 10 }, splitLine: { lineStyle: { color: '#f0f0f0' } } },
    { gridIndex: 1, axisLabel: { show: false }, splitLine: { show: false } },
  ];
  const series = [
    { name: '价格', type: 'line', data: prices, showSymbol: false, lineStyle: { width: 1.5, color: '#2f6fed' }, areaStyle: { color: 'rgba(47,111,237,.08)' } },
    { name: '均价', type: 'line', data: avgs, showSymbol: false, lineStyle: { width: 1, color: '#f59e0b' } },
    { name: '量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: data.map((d, i) => ({ value: d.volume, itemStyle: { color: prices[i] >= (prices[i - 1] ?? prices[i]) ? '#e23c3c' : '#1aa260' } })) },
  ];
  const titles = [{ text: '成交量 (每分钟分时量)', left: 50, top: '50%', textStyle: SUB_TITLE }];

  // 副图: 通达信日内T指标 + MACD
  if (intra && intra.cats && intra.cats.length) {
    appendIntradayT(grids, xAxes, yAxes, series, titles, cats, intra, 50, 20, '64%', '20%');
    appendIntradayMacd(grids, xAxes, yAxes, series, titles, cats, prices, 50, 20, '86%', '12%');
  }

  // 做T分析顶底标记叠加(绝对价模式)
  const tbMP = tbMarkPoint(opts.topsBottoms, (p) => p);
  if (tbMP) series[0].markPoint = tbMP;

  return {
    animation: false,
    title: titles,
    tooltip: { trigger: 'axis' },
    legend: { data: ['价格', '均价'], top: 2, fontSize: 11 },
    grid: grids, xAxis: xAxes, yAxis: yAxes,
    series,
  };
}

// 分时图·双轴(左=振幅%/右=价格)：主图价格线与均价线画在右轴(绝对价格)，
//   左轴显示「相对昨收的涨跌幅%」(0 居中)，与右轴线性对应(左值=(右值/昨收-1)*100)。
//   鼠标悬停 tooltip 仅显示价格/均价(¥)，不显示振幅百分比。
//   prevClose 缺失时回退到当日首价(开盘)作为基准。
export function minuteDualAxisOption(data, intra, opts = {}) {
  const prevClose = (opts.prevClose && opts.prevClose > 0) ? opts.prevClose : (data.length ? data[0].price : 0);
  const cats = data.map((d) => d.t);
  const prices = data.map((d) => d.price);
  const avgs = data.map((d) => d.avg);
  const pcts = prices.map((p) => (p - prevClose) / prevClose * 100);
  const maxAbs = Math.max(0.5, ...pcts.map((v) => Math.abs(v))) * 1.12;
  const priceMin = +(prevClose * (1 - maxAbs / 100)).toFixed(3);
  const priceMax = +(prevClose * (1 + maxAbs / 100)).toFixed(3);
  const grids = [
    { left: 56, right: 56, top: 24, height: '45%' },   // 价格主图(双轴)
    { left: 56, right: 56, top: '52%', height: '9%' }, // 成交量
  ];
  const xAxes = [
    { type: 'category', data: cats, axisLabel: { fontSize: 10, interval: 30 } },
    { type: 'category', data: cats, gridIndex: 1, axisLabel: { show: false } },
  ];
  const yAxes = [
    {
      gridIndex: 0, position: 'left', min: -maxAbs, max: maxAbs, scale: false,
      axisLabel: { fontSize: 10, formatter: (v) => (v > 0 ? '+' : '') + Number(v).toFixed(1) + '%' },
      splitLine: { lineStyle: { color: '#f0f0f0' } }, axisLine: { show: true, lineStyle: { color: '#ccc' } },
    },
    {
      gridIndex: 0, position: 'right', min: priceMin, max: priceMax, scale: false,
      axisLabel: { fontSize: 10, formatter: (v) => Number(v).toFixed(2) },
      splitLine: { show: false },
    },
    { gridIndex: 1, axisLabel: { show: false }, splitLine: { show: false } }, // 成交量轴
  ];
  // 价格/均价走右轴(yAxisIndex=1)，成交量走 grid1 轴
  const series = [
    {
      name: '价格', type: 'line', yAxisIndex: 1, data: prices, showSymbol: false,
      lineStyle: { width: 1.5, color: '#2f6fed' }, areaStyle: { color: 'rgba(47,111,237,.08)' },
      markLine: { silent: true, symbol: 'none', lineStyle: { type: 'dashed', color: '#999' }, data: [{ yAxis: prevClose }] },
    },
    { name: '均价', type: 'line', yAxisIndex: 1, data: avgs, showSymbol: false, lineStyle: { width: 1, color: '#f59e0b' } },
    {
      name: '量', type: 'bar', xAxisIndex: 1, yAxisIndex: 2,
      data: data.map((d, i) => ({ value: d.volume, itemStyle: { color: prices[i] >= (prices[i - 1] ?? prices[i]) ? '#e23c3c' : '#1aa260' } })),
    },
  ];
  const titles = [{ text: '昨收 ' + prevClose.toFixed(2) + ' · 成交量（每分钟分时量）', left: 56, top: '50%', textStyle: SUB_TITLE }];

  // 副图: 通达信日内T指标 + MACD (双轴下方)
  if (intra && intra.cats && intra.cats.length) {
    appendIntradayT(grids, xAxes, yAxes, series, titles, cats, intra, 56, 56, '64%', '20%');
    appendIntradayMacd(grids, xAxes, yAxes, series, titles, cats, prices, 56, 56, '86%', '12%');
  }

  // 做T分析顶底标记叠加(价格轴)
  const tbMP = tbMarkPoint(opts.topsBottoms, (p) => p);
  if (tbMP) series[0].markPoint = tbMP;

  return {
    animation: false,
    title: titles,
    tooltip: {
      trigger: 'axis',
      // 仅显示价格/均价(¥)，不显示振幅百分比
      formatter: (params) => {
        if (!params || !params.length) return '';
        let s = '<div style="font-size:12px;margin-bottom:2px">' + (params[0].axisValue || '') + '</div>';
        for (const p of params) {
          if (p.seriesName === '价格' || p.seriesName === '均价') {
            s += '<div>' + p.marker + p.seriesName + ': <b>' + Number(p.value).toFixed(2) + '</b></div>';
          }
        }
        return s;
      },
    },
    legend: { data: ['价格', '均价'], top: 2, fontSize: 11 },
    grid: grids, xAxis: xAxes, yAxis: yAxes,
    series,
  };
}

// 分时图 + 大盘指数叠加: 主图改为"涨跌幅%"双线(个股 / 大盘), 纵坐标以昨收=0 为中心(整幅0为中心点)
// 数据(data = 个股分时绝对价; cmp.stock.points 已含个股 pct 与对齐的大盘 ipct); 成交量 / 通达信T副图保持原样。
function minuteCompareOption(data, intra, cmp, tb) {
  const cats = data.map((d) => d.t);
  const prices = data.map((d) => d.price);
  const spct = cmp.stock.points.map((p) => p.pct);
  const ipct = cmp.stock.points.map((p) => (p.ipct == null ? null : p.ipct));
  const prevC = cmp.stock.prevClose || 0;
  const avgPct = data.map((d) => (d.avg != null && prevC ? (d.avg - prevC) / prevC * 100 : null));
  // 对称纵坐标: 取个股/大盘/均价 中最大绝对涨跌幅, 0 居中
  const vals = [...spct, ...ipct.filter((v) => v != null), ...avgPct.filter((v) => v != null)]
    .filter((v) => typeof v === 'number' && isFinite(v));
  const maxAbs = vals.length ? Math.max.apply(null, vals.map((v) => Math.abs(v))) : 1;
  const pad = maxAbs * 1.08 || 1;
  const yMin = -pad, yMax = pad;
  const idxName = (cmp.index && cmp.index.name) ? cmp.index.name : '大盘';
  const grids = [
    { left: 56, right: 20, top: 24, height: '45%' },   // 涨跌幅主图
    { left: 56, right: 20, top: '52%', height: '9%' }, // 成交量
  ];
  const xAxes = [
    { type: 'category', data: cats, axisLabel: { fontSize: 10, interval: 30 } },
    { type: 'category', data: cats, gridIndex: 1, axisLabel: { show: false } },
  ];
  const yAxes = [
    {
      min: yMin, max: yMax, scale: false,
      axisLabel: { fontSize: 10, formatter: (v) => (v > 0 ? '+' : '') + Number(v).toFixed(1) + '%' },
      splitLine: { lineStyle: { color: '#f0f0f0' } }, axisLine: { show: true, lineStyle: { color: '#ccc' } },
    },
    { gridIndex: 1, axisLabel: { show: false }, splitLine: { show: false } },
  ];
  // 主图: 个股(蓝, 含0基准线) + 均价(橙虚) + 大盘(紫)
  const series = [
    {
      name: '个股', type: 'line', data: spct, showSymbol: false,
      lineStyle: { width: 1.5, color: '#2f6fed' }, areaStyle: { color: 'rgba(47,111,237,.08)' },
      markLine: { silent: true, symbol: 'none', lineStyle: { type: 'dashed', color: '#e23c3c' }, data: [{ yAxis: 0 }] },
    },
    { name: '均价', type: 'line', data: avgPct, showSymbol: false, lineStyle: { width: 1, color: '#f59e0b' } },
    { name: idxName, type: 'line', data: ipct, showSymbol: false, lineStyle: { width: 1.5, color: '#8b5cf6' } },
    {
      name: '量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1,
      data: data.map((d, i) => ({ value: d.volume, itemStyle: { color: (spct[i] ?? 0) >= (spct[i - 1] ?? spct[i] ?? 0) ? '#e23c3c' : '#1aa260' } })),
    },
  ];
  const legend = ['个股', '均价', idxName];
  const titles = [{ text: '成交量（每分钟分时量）', left: 56, top: '50%', textStyle: SUB_TITLE }];
  // 副图: 通达信日内T指标 + MACD —— 与双轴/绝对价图一致
  if (intra && intra.cats && intra.cats.length) {
    appendIntradayT(grids, xAxes, yAxes, series, titles, cats, intra, 56, 20, '64%', '20%');
    appendIntradayMacd(grids, xAxes, yAxes, series, titles, cats, prices, 56, 20, '86%', '12%');
  }

  // 做T分析顶底标记叠加(大盘叠加模式: 价格转涨跌幅%)
  const tbMPc = tbMarkPoint(tb, (p) => (prevC ? (p - prevC) / prevC * 100 : p));
  if (tbMPc) series[0].markPoint = tbMPc;

  return {
    animation: false,
    title: titles,
    tooltip: { trigger: 'axis' },
    legend: { data: legend, top: 2, fontSize: 11 },
    grid: grids, xAxis: xAxes, yAxis: yAxes,
    series,
  };
}

// 分时图 + 买卖点叠加 (回测页: 交易明细/手动标注在分时图体现)
// data: [{t, price, avg?, volume, ...}]  marks: [{time?, price, type:'buy'|'sell'}]
//   - 提供 time 时精确定位; 仅提供 price 时由组件自动取最近棒的时间(见 IntradayTradeChart)
export function intradayMarksOption(data, marks, opts = {}) {
  const cats = data.map((d) => d.t);
  const prices = data.map((d) => d.price);
  const avgs = data.map((d) => (d.avg == null ? null : d.avg));
  // 主图/量图网格不重叠(否则 containPixel/点击命中会错乱)
  const grids = [
    { left: 50, right: 20, top: 30, height: '54%' },   // 价格主图
    { left: 50, right: 20, top: '86%', height: '12%' }, // 成交量
  ];
  const xAxes = [
    { type: 'category', data: cats, axisLabel: { fontSize: 10, interval: Math.max(0, Math.floor(cats.length / 8)) } },
    { type: 'category', data: cats, gridIndex: 1, axisLabel: { show: false } },
  ];
  // 纵坐标按"振幅"动态设置: 取 价格/均价/买卖点价 的最小~最大, 上下各留 10% 余量, 不从 0 开始, 让波动更明显
  const vals = [];
  prices.forEach((v) => { if (v != null) vals.push(v); });
  avgs.forEach((v) => { if (v != null) vals.push(v); });
  (marks || []).forEach((m) => { if (m.price != null) vals.push(m.price); });
  let yMin, yMax;
  if (vals.length) {
    const lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    const pad = (hi - lo) * 0.1 || hi * 0.02 || 0.01;
    yMin = +(lo - pad).toFixed(3);
    yMax = +(hi + pad).toFixed(3);
  }
  const yAxes = [
    { scale: true, min: yMin, max: yMax, axisLabel: { fontSize: 10 }, splitLine: { lineStyle: { color: '#f0f0f0' } } },
    { gridIndex: 1, axisLabel: { show: false }, splitLine: { show: false } },
  ];
  // 买卖价参考线(水平虚线)
  const markLineData = [];
  (marks || []).forEach((m) => {
    if (m.price != null) markLineData.push({ yAxis: m.price, lineStyle: { type: 'dashed', color: m.type === 'buy' ? '#e23c3c' : '#1aa260' } });
  });
  const series = [
    {
      name: '价格', type: 'line', data: prices, showSymbol: false,
      lineStyle: { width: 1.5, color: '#2f6fed' }, areaStyle: { color: 'rgba(47,111,237,.08)' },
      markLine: markLineData.length ? { silent: true, symbol: 'none', data: markLineData } : undefined,
    },
    { name: '均价', type: 'line', data: avgs, showSymbol: false, lineStyle: { width: 1, color: '#f59e0b' } },
    {
      name: '量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1,
      data: data.map((d, i) => ({ value: d.volume, itemStyle: { color: prices[i] >= (prices[i - 1] ?? prices[i]) ? '#e23c3c' : '#1aa260' } })),
    },
  ];
  // 买卖点散点(自动定位的时间用 m.time); 标签直接显示"买/卖 + 价格", 点击后即时可见设置的值
  const scatterData = (marks || []).map((m) => ({
    value: [m.time, m.price],
    symbol: m.type === 'buy' ? 'triangle' : 'pin',
    symbolSize: m.type === 'buy' ? 14 : 18,
    symbolOffset: [0, m.type === 'buy' ? 8 : -10],
    itemStyle: { color: m.type === 'buy' ? '#e23c3c' : '#1aa260' },
    label: {
      show: true,
      formatter: (m.type === 'buy' ? '买 ' : '卖 ') + (m.price != null ? Number(m.price).toFixed(2) : ''),
      fontSize: 10, fontWeight: 'bold', color: '#fff',
      backgroundColor: m.type === 'buy' ? '#e23c3c' : '#1aa260',
      padding: [2, 4], borderRadius: 3,
    },
  }));
  series.push({ name: '买卖点', type: 'scatter', data: scatterData, z: 10, tooltip: { show: false } });

  return {
    animation: false,
    title: [
      { text: opts.title || '当日分时', left: 8, top: 2, textStyle: { fontSize: 12, color: '#444' } },
      { text: '成交量（每分钟分时量）', left: 50, top: '84%', textStyle: SUB_TITLE },
    ],
    tooltip: { trigger: 'axis' },
    legend: { data: ['价格', '均价'], top: 2, right: 8, fontSize: 11 },
    grid: grids, xAxis: xAxes, yAxis: yAxes,
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1], start: 0, end: 100 }],
    series,
  };
}

// 权益曲线
export function equityOption(equity) {
  return {
    animation: false,
    tooltip: { trigger: 'axis' },
    grid: { left: 60, right: 20, top: 20, bottom: 40 },
    xAxis: { type: 'category', data: equity.map((e) => e.date), axisLabel: { fontSize: 10, interval: Math.floor(equity.length / 8) } },
    yAxis: { type: 'value', axisLabel: { fontSize: 10, formatter: '¥{value}' }, splitLine: { lineStyle: { color: '#f0f0f0' } } },
    series: [{ type: 'line', data: equity.map((e) => e.equity), smooth: true, showSymbol: false, areaStyle: { color: 'rgba(226,60,60,.1)' }, lineStyle: { color: '#e23c3c', width: 2 } }],
  };
}

// 简单柱图(资金流等)
export function barOption(cats, values, colorPos = '#e23c3c', colorNeg = '#1aa260') {
  return {
    animation: false, tooltip: { trigger: 'axis' },
    grid: { left: 60, right: 20, top: 20, bottom: 40 },
    xAxis: { type: 'category', data: cats, axisLabel: { fontSize: 10 } },
    yAxis: { type: 'value', axisLabel: { fontSize: 10 } },
    series: [{ type: 'bar', data: values.map((v) => ({ value: v, itemStyle: { color: v >= 0 ? colorPos : colorNeg } })) }],
  };
}
