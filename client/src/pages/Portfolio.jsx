import React, { useEffect, useState } from 'react';
import { api, fmt } from '../api';

export default function Portfolio() {
  const [rows, setRows] = useState([]);
  const [edit, setEdit] = useState(null);
  const [tGain, setTGain] = useState({}); // code -> 今日做T预估收益

  const load = () => api.portfolio().then((r) => setRows(r.data || []));
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, []);

  const totalMkt = rows.reduce((s, r) => s + (r.mktVal || 0), 0);
  const totalCost = rows.reduce((s, r) => s + (r.costVal || 0), 0);
  const totalPnl = rows.reduce((s, r) => s + (r.pnl || 0), 0);

  const save = async (list) => { await api.savePortfolio(list); load(); };
  const addRow = () => setEdit({ code: '', name: '', shares: 0, cost: 0, note: '', _new: true });
  const commit = async () => {
    const clean = { code: edit.code, name: edit.name, shares: +edit.shares, cost: +edit.cost, note: edit.note };
    const base = rows.map((r) => ({ code: r.code, name: r.name, shares: r.shares, cost: r.cost, note: r.note }));
    const idx = base.findIndex((b) => b.code === clean.code);
    if (idx >= 0) base[idx] = clean; else base.push(clean);
    setEdit(null); await save(base);
  };
  const remove = async (code) => { const base = rows.filter((r) => r.code !== code).map((r) => ({ code: r.code, name: r.name, shares: r.shares, cost: r.cost, note: r.note })); await save(base); };

  return (
    <div>
      <div className="row" style={{ marginBottom: 4 }}>
        <div className="metric"><div className="k">总市值</div><div className="v">{fmt.money(totalMkt)}</div></div>
        <div className="metric"><div className="k">总成本</div><div className="v" style={{ fontSize: 18 }}>{fmt.money(totalCost)}</div></div>
        <div className="metric"><div className="k">浮动盈亏</div><div className={'v ' + fmt.cls(totalPnl)}>{fmt.money(totalPnl)}</div></div>
        <div className="metric"><div className="k">盈亏比例</div><div className={'v ' + fmt.cls(totalPnl)}>{totalCost ? fmt.pct((totalPnl / totalCost) * 100) : '--'}</div></div>
      </div>

      <div className="panel">
        <h3>💼 组合持仓 <span className="pill">现价8s刷新 · 手动录入</span> <button className="btn" style={{ marginLeft: 'auto' }} onClick={addRow}>+ 新增持仓</button></h3>
        <table>
          <thead><tr><th>名称</th><th>代码</th><th>股数</th><th>成本</th><th>现价</th><th>涨跌幅</th><th>市值</th><th>浮动盈亏</th><th>盈亏%</th><th>操作</th></tr></thead>
          <tbody>
            {rows.map((r) => <tr key={r.code}>
              <td>{r.name}</td><td>{r.code}</td><td>{r.shares.toLocaleString()}</td><td>{fmt.price(r.cost)}</td>
              <td className={fmt.cls(r.change_pct)}>{fmt.price(r.price)}</td>
              <td className={fmt.cls(r.change_pct)}>{fmt.pct(r.change_pct)}</td>
              <td>{fmt.money(r.mktVal)}</td>
              <td className={fmt.cls(r.pnl)}>{fmt.money(r.pnl)}</td>
              <td className={fmt.cls(r.pnl)}>{fmt.pct(r.pnlPct)}</td>
              <td><button className="btn" onClick={() => setEdit({ ...r })}>编辑</button> <button className="btn" onClick={() => remove(r.code)}>删</button></td>
            </tr>)}
          </tbody>
        </table>
        {rows.some((r) => r.note) && <div className="muted" style={{ marginTop: 8 }}>
          {rows.filter((r) => r.note).map((r) => <div key={r.code}>· {r.name}：{r.note}</div>)}
        </div>}
      </div>

      <div className="panel">
        <h3>🔁 做T降本分析 <span className="pill">基于回测标准T</span></h3>
        <TAnalysis rows={rows} />
      </div>

      {edit && <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }} onClick={() => setEdit(null)}>
        <div className="panel" style={{ width: 'min(360px, 92vw)' }} onClick={(e) => e.stopPropagation()}>
          <h3>{edit._new ? '新增持仓' : '编辑持仓'}</h3>
          <div style={{ display: 'grid', gap: 8 }}>
            <label>代码 <input value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value.trim() })} disabled={!edit._new} /></label>
            <label>名称 <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
            <label>股数 <input type="number" value={edit.shares} onChange={(e) => setEdit({ ...edit, shares: e.target.value })} /></label>
            <label>成本 <input type="number" step="0.001" value={edit.cost} onChange={(e) => setEdit({ ...edit, cost: e.target.value })} /></label>
            <label>备注 <input value={edit.note || ''} onChange={(e) => setEdit({ ...edit, note: e.target.value })} /></label>
          </div>
          <div style={{ marginTop: 12, textAlign: 'right' }}><button className="btn" onClick={() => setEdit(null)}>取消</button> <button className="btn primary" onClick={commit}>保存</button></div>
        </div>
      </div>}
    </div>
  );
}

function TAnalysis({ rows }) {
  const [data, setData] = useState({});
  useEffect(() => {
    rows.forEach((r) => {
      api.backtest({ code: r.code, strategy: 't0', qty: 2000, variant: 'standard' }).then((res) => {
        if (res.ok) setData((d) => ({ ...d, [r.code]: res }));
      });
    });
  }, [rows.length]);
  return (
    <table>
      <thead><tr><th>名称</th><th>持仓成本</th><th>近6月做T净收益(2000股/日)</th><th>胜率</th><th>日内价差中位</th><th>估算降本后成本*</th></tr></thead>
      <tbody>{rows.map((r) => { const res = data[r.code]; const m = res && res.metrics;
        // 估算: 做T净收益/总股数 => 每股降本(仅示意)
        const perShare = m ? m.net / r.shares : null;
        const newCost = perShare != null ? (r.cost - perShare) : null;
        return <tr key={r.code}>
          <td>{r.name}</td><td>{fmt.price(r.cost)}</td>
          <td className={m ? fmt.cls(m.net) : ''}>{m ? fmt.money(m.net) : '计算中…'}</td>
          <td>{m ? m.win_rate + '%' : '--'}</td>
          <td>{res && res.median_gap_pct ? res.median_gap_pct + '%' : '--'}</td>
          <td>{newCost != null ? fmt.price(newCost) : '--'}</td>
        </tr>; })}</tbody>
    </table>
  );
}
