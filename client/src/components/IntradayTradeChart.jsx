import React, { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts';
import { api } from '../api';
import { intradayMarksOption } from './Chart';

// 把 mark 的价格定位到该日时序中最接近的棒(用于结果回测的 buy/sell 价自动落点)
function resolveMarks(marks, data) {
  if (!data || !data.length) return [];
  return (marks || []).map((m) => {
    if (m.time) return m;
    // 仅给了 price: 找收盘价最接近的一根, 优先靠前的(避免总落在尾盘)
    let best = 0, bestD = Infinity;
    for (let i = 0; i < data.length; i++) {
      const d = Math.abs((data[i].price ?? data[i].close) - m.price);
      if (d < bestD) { bestD = d; best = i; }
    }
    return { ...m, time: data[best].t };
  });
}

/**
 * 当日分时图(可交互标注买卖点)
 * props:
 *   code, date        股票与交易日
 *   marks             [{time?, price, type:'buy'|'sell'}] 展示用
 *   interactive       是否允许点击标注
 *   markMode          'buy' | 'sell' (interactive 时新标注的类型)
 *   onAddMark(mark)   点击时回调: { date, time, price, type }
 *   title, height
 */
export default function IntradayTradeChart({ code, date, marks = [], interactive = false, markMode = 'buy', onAddMark, height = 320, title }) {
  const elRef = useRef(null);
  const chartRef = useRef(null);
  const dataRef = useRef(null);
  const markModeRef = useRef(markMode);
  const onAddMarkRef = useRef(onAddMark);
  const dateRef = useRef(date);
  markModeRef.current = markMode;
  onAddMarkRef.current = onAddMark;
  dateRef.current = date;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    if (!code || !date) { setData(null); return; }
    setLoading(true); setErr('');
    api.backtestDay(code, date)
      .then((r) => {
        if (!alive) return;
        if (r.ok && r.data && r.data.length) setData(r.data);
        else { setData(null); setErr(r.error || '无数据'); }
        setLoading(false);
      })
      .catch((e) => { if (alive) { setErr(e.message); setLoading(false); } });
    return () => { alive = false; };
  }, [code, date]);

  // echarts 实例生命周期
  useEffect(() => {
    if (!elRef.current) return;
    const chart = echarts.init(elRef.current);
    chartRef.current = chart;
    const onResize = () => { try { chart.resize(); } catch (_) {} };
    window.addEventListener('resize', onResize);
    let ro;
    try { if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(() => { try { chart.resize(); } catch (_) {} }); ro.observe(elRef.current); } } catch (_) {}
    return () => {
      window.removeEventListener('resize', onResize);
      try { ro && ro.disconnect(); } catch (_) {}
      try { chart.dispose(); } catch (_) {}
      chartRef.current = null;
    };
  }, []);

  // 数据/marks 变化 -> 重绘
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (!data) { try { chart.clear(); } catch (_) {} return; }
    dataRef.current = data;
    const resolved = resolveMarks(marks, data);
    try { chart.setOption(intradayMarksOption(data, resolved, { title }), true); }
    catch (e) { console.error('[IntradayTradeChart] setOption 失败:', e); }
  }, [data, marks, title]);

  // 交互: 点击主图 -> 取最近棒的 time/price 回调
  // 用 ref 保存最新值, 监听器只在 interactive 切换时绑定一次(避免每次父级重渲染重复解绑/闭包陈旧)
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !interactive) return;
    const handler = (e) => {
      const d = dataRef.current;
      if (!d || !d.length) return;
      // 取点击在图表容器内的像素坐标: 优先用原生 DOM 事件的 clientX/Y 减去容器矩形,
      // 因为 zrender 的 e.offsetX/offsetY 在空白区域常为 undefined, 会导致坐标计算错误。
      const rect = chart.getDom().getBoundingClientRect();
      const native = (e && e.event) || e;
      const clientX = native && native.clientX != null ? native.clientX : (e && e.offsetX);
      const clientY = native && native.clientY != null ? native.clientY : (e && e.offsetY);
      if (clientX == null || clientY == null) return;
      const px = clientX - rect.left;   // 相对图表容器左
      const py = clientY - rect.top;    // 相对图表容器顶
      if (py < 0 || px < 0) return;     // 点击落在图表容器外(如标题栏上方), 忽略
      // 像素 -> 数据坐标: convertFromPixel 在不同版本/参数下可能返回
      //   1) 数组 [xVal, yVal] (finder=gridIndex) 2) 标量(类目索引, finder=xAxisIndex) 3) 类目字符串
      // 三种形态都必须兼容, 否则取 xv[0] 会得到 undefined -> Math.round->NaN -> 静默失败。
      let conv = null;
      try { conv = chart.convertFromPixel({ gridIndex: 0 }, [px, py]); } catch (_) { conv = null; }
      if (conv == null) { try { conv = chart.convertFromPixel({ xAxisIndex: 0 }, [px, py]); } catch (_) { conv = null; } }
      let xv = null;
      if (conv != null) xv = Array.isArray(conv) ? conv[0] : conv;
      if (xv == null) return; // 坐标转换失败则忽略本次点击
      let idx;
      if (typeof xv === 'number') idx = Math.round(xv);
      else { const i = d.findIndex((b) => b.t === xv); if (i < 0) return; idx = i; } // 类目字符串 -> 找索引
      idx = Math.max(0, Math.min(d.length - 1, idx));
      const bar = d[idx];
      const cb = onAddMarkRef.current;
      if (cb && bar) {
        const avg = (bar.avg != null && isFinite(Number(bar.avg))) ? +Number(bar.avg).toFixed(3) : null;
        cb({
          date: dateRef.current, time: bar.t,
          price: +(Number(bar.price ?? bar.close)).toFixed(2),
          avg,
          type: markModeRef.current,
        });
      }
    };
    chart.getZr().on('click', handler);
    return () => chart.getZr().off('click', handler);
  }, [interactive]);

  return (
    <div style={{ position: 'relative' }}>
      {loading && <div className="muted" style={{ position: 'absolute', right: 10, top: 4, zIndex: 2, pointerEvents: 'none' }}>加载中…</div>}
      {err && !data && <div className="muted" style={{ padding: 8, color: '#e23c3c' }}>{err}</div>}
      {interactive && data && (
        <div className="muted" style={{ position: 'absolute', left: 10, top: 4, zIndex: 2, background: 'rgba(255,255,255,.7)', padding: '0 4px', pointerEvents: 'none' }}>
          {markMode === 'buy' ? '🖱 点击设买点' : '🖱 点击设卖点'}
        </div>
      )}
      <div ref={elRef} style={{ width: '100%', height }} />
    </div>
  );
}
