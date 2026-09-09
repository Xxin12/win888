import React from 'react';
import { fmt } from '../api';

/**
 * 日内做T决策面板 (系统核心)
 * 输入: quote(实时报价), avg(当日成交均价/VWAP), gapPct(回测日内价差中位%), winRate,
 *       minute(当日分时序列, 兜底取最高/最低), minutePreclose/replayPrevClose(兜底昨收)
 * 计算: 买区/卖区参考价、日内位置、信号
 * 说明: 已移除「持仓成本/相对成本」；行情数据优先取实时 quote，缺失时由分时序列/回放兜底，确保不出现空值。
 * 配色: 整块面板底色随当日涨跌(涨=红/跌=绿/平=灰)，买卖信号仅作文字标题。
 */
export default function TTDecisionPanel({ quote, avg, gapPct = 0.96, winRate, minute = [], minutePreclose = null, replayPrevClose = null }) {
  if (!quote) return <div className="panel"><h3>🎯 做T决策面板</h3><div className="muted">等待实时行情…</div></div>;

  const price = quote.price;
  // 昨收: 优先实时 quote, 兜底 分时接口/回放(raw, 与分时同尺度)
  const prevClose = quote.preclose ?? minutePreclose ?? replayPrevClose;
  const open = quote.open;
  // 最高/最低: 优先实时 quote, 兜底从当日分时序列取(避免 quote 部分字段缺失时空白)
  const dayHigh = (minute && minute.length) ? Math.max.apply(null, minute.map((m) => m.price)) : null;
  const dayLow = (minute && minute.length) ? Math.min.apply(null, minute.map((m) => m.price)) : null;
  const high = (typeof quote.high === 'number' && quote.high > 0) ? quote.high : dayHigh;
  const low = (typeof quote.low === 'number' && quote.low > 0) ? quote.low : dayLow;
  const chgPct = quote.change_pct;
  const turnover = quote.turnover;

  const half = gapPct / 2 / 100;
  const base = prevClose || price;            // 持仓成本已移除 → 以昨收为基准
  const buyZone = +(base * (1 - half)).toFixed(3);
  const sellZone = +(base * (1 + half)).toFixed(3);

  // 日内位置 0(最低)~100(最高)
  const range = (high != null && low != null) ? high - low : 0;
  const pos = range > 0 ? Math.round(((price - low) / range) * 100) : 50;

  // 信号(仅作文字提示, 不改变面板底色)
  let signal = 'hold', title = '观望', desc = '价格处于中间区域，等待进入买/卖区';
  if (price <= buyZone) { signal = 'buy'; title = '低吸做T (买入回补)'; desc = `现价 ≤ 买区参考 ${buyZone}，且处于日内低位(${pos}%)，可考虑低吸`; }
  else if (price >= sellZone) { signal = 'sell'; title = '高抛做T (卖出)'; desc = `现价 ≥ 卖区参考 ${sellZone}，且处于日内高位(${pos}%)，可考虑高抛`; }
  else if (pos <= 25) { signal = 'buy'; title = '接近买区'; desc = `日内低位(${pos}%)，可挂限价买单于 ${buyZone} 附近`; }
  else if (pos >= 75) { signal = 'sell'; title = '接近卖区'; desc = `日内高位(${pos}%)，可挂限价卖单于 ${sellZone} 附近`; }

  // 面板底色随当日涨跌(涨红/跌绿/平灰)
  const dirCls = chgPct > 0 ? 'up-panel' : chgPct < 0 ? 'down-panel' : 'flat-panel';

  const ampPct = (prevClose && high > 0 && low > 0) ? ((high - low) / prevClose) * 100 : null;
  const clsOf = (v) => (v == null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '');

  // 全部行情数据合并进单个框(振幅/昨收价/换手率/成交均价/当前股价/最高价/最低价/今开价), 2列网格, 20px
  const metrics = [
    { label: '振幅', value: ampPct != null ? ampPct.toFixed(2) + '%' : '--', cls: '' },
    { label: '昨收价', value: fmt.price(prevClose), cls: '' },
    { label: '换手率', value: (typeof turnover === 'number') ? turnover.toFixed(2) + '%' : '--', cls: '' },
    { label: '成交均价', value: avg != null ? fmt.price(avg) : '--', cls: clsOf(avg != null && prevClose ? avg - prevClose : null) },
    { label: '当前股价', value: fmt.price(price) + '  ' + fmt.pct(chgPct), cls: fmt.cls(chgPct) },
    { label: '最高价', value: fmt.price(high), cls: clsOf(high != null ? high - prevClose : null) },
    { label: '最低价', value: fmt.price(low), cls: clsOf(low != null ? low - prevClose : null) },
    { label: '今开价', value: fmt.price(open), cls: clsOf(open != null ? open - prevClose : null) },
  ];

  return (
    <div className="panel">
      <h3>🎯 做T决策面板 <span className="pill">基于回测日内价差中位 {gapPct}%{winRate ? ` · 历史胜率 ${winRate}%` : ''}</span></h3>
      <div className={'decision ' + dirCls}>
        <div className="decision-top" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <div>
            <div style={{ fontSize: 13, opacity: .9 }}>{quote.name} {quote.code}</div>
            {/* 大价/涨跌幅置于彩色面板上用白字(避免红字红底看不清), 涨跌方向由面板底色表达 */}
            <div className="bigprice">{fmt.price(price)}</div>
            <div style={{ fontSize: 13, marginTop: 4 }}>{fmt.pct(chgPct)} · 日内位置 {pos}%</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 20, fontWeight: 800 }}>{title}</div>
            <div style={{ fontSize: 12, opacity: .9, maxWidth: 260, marginTop: 4 }}>{desc}</div>
          </div>
        </div>
        {/* 全部行情数据: 单框整合, 2列网格, 20px, 显式深色字修复白底白字(继承自 .decision 的 #fff); 涨/跌项仍红绿着色 */}
        <div style={{ marginTop: 10, background: '#fff', border: '1px solid #e3e6ea', borderRadius: 10, padding: '12px 14px', color: '#1a1a1a' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#555', marginBottom: 8 }}>行情数据</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 24px' }}>
            {metrics.map((it) => (
              <div key={it.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
                <span className="muted" style={{ fontSize: 14, whiteSpace: 'nowrap', flex: '0 0 auto' }}>{it.label}</span>
                <b className={it.cls} style={{ fontSize: 20, fontWeight: 800, whiteSpace: 'nowrap', textAlign: 'right', marginLeft: 'auto' }}>{it.value}</b>
              </div>
            ))}
          </div>
        </div>
        <div className="zone" style={{ marginTop: 8 }}>
          <div className="z"><div className="zk">买区参考 (≤)</div><div className="zv">{buyZone}</div></div>
          <div className="z"><div className="zk">卖区参考 (≥)</div><div className="zv">{sellZone}</div></div>
        </div>
      </div>
    </div>
  );
}
