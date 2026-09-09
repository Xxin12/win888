import React, { useEffect, useState, useMemo } from 'react';
import { api, fmt } from '../api';

export default function Watchlist({ quotes }) {
  const [wl, setWl] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [hits, setHits] = useState([]);
  const [al, setAl] = useState({ code: 'sz002027', type: 'price', op: '<=', value: 4.7, note: '' });
  // 自选添加：代码/名称搜索（按行情中心方式，支持名称模糊匹配 + 下拉候选）
  const [universe, setUniverse] = useState([]);   // 全量股票池 {code,name,market}
  const [kw, setKw] = useState('');               // 搜索框输入（代码或名称）
  const [matches, setMatches] = useState([]);      // 候选下拉
  const [openSel, setOpenSel] = useState(false);   // 下拉是否展开
  const [picked, setPicked] = useState(null);      // 选中的候选 {code,name}

  const load = () => {
    api.watchlist().then((r) => setWl(r.data || []));
    api.alerts().then((r) => setAlerts(r.data || []));
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    const t = setInterval(() => api.evalAlerts().then((r) => setHits(r.hits || [])), 10000);
    api.evalAlerts().then((r) => setHits(r.hits || []));
    return () => clearInterval(t);
  }, []);
  // 加载股票池（用于名称搜索），与行情中心一致
  useEffect(() => {
    api.stocks().then((r) => { if (r && r.ok && r.stocks) setUniverse(r.stocks); }).catch(() => {});
  }, []);

  // 候选匹配：代码(含前缀)或名称(含关键字)，最多展示 12 条
  const kwUpper = kw.trim().toUpperCase();
  const filteredMatches = useMemo(() => {
    if (!kwUpper) return [];
    return universe
      .filter((s) => s.code.toUpperCase().includes(kwUpper) || (s.name || '').toUpperCase().includes(kwUpper))
      .slice(0, 12);
  }, [universe, kwUpper]);

  const choose = (s) => {
    setPicked(s);
    setKw(s.code + ' ' + s.name);
    setOpenSel(false);
  };
  const onSearchChange = (e) => {
    const v = e.target.value;
    setKw(v);
    setOpenSel(true);
    setPicked(null);
    // 若输入恰好等于某候选 code(含前缀) 或 纯6位数字，直接选中之（便于键盘直接添加）
    const u = v.trim().toUpperCase();
    const exact = universe.find((s) => s.code.toUpperCase() === u || (u.length === 6 && /^\d{6}$/.test(u) && s.code.endsWith(u)));
    if (exact) setPicked(exact);
  };

  const addWatch = async () => {
    const code = picked ? picked.code : (kw.trim().length === 6 ? 'sh' + kw.trim() : null);
    if (!code) return;
    // 名称：优先用选中的；否则尝试从候选/股票池反查；都没有则留空由后端回退
    let name = picked ? picked.name : '';
    if (!name) {
      const u = kw.trim().toUpperCase();
      const hit = universe.find((s) => s.code.toUpperCase() === u || s.code.toUpperCase().endsWith(u) || (s.name || '').toUpperCase().includes(u));
      name = hit ? hit.name : '';
    }
    await api.addWatch({ code, name });
    setKw(''); setPicked(null); setOpenSel(false); load();
  };
  const delWatch = async (c) => { await api.delWatch(c); load(); };
  const addAlert = async () => { await api.addAlert(al); load(); };
  const delAlert = async (id) => { await api.delAlert(id); load(); };

  return (
    <div>
      <div className="panel">
        <h3>⭐ 自选监控 <span className="pill">实时推送 · 涨红跌绿</span></h3>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap', position: 'relative' }}>
          <input
            placeholder="搜索代码 / 名称，如 000001 或 分众传媒"
            value={kw}
            onChange={onSearchChange}
            onFocus={() => setOpenSel(true)}
            style={{ width: 260 }}
            autoComplete="off"
          />
          {openSel && filteredMatches.length > 0 && (
            <div style={{ position: 'absolute', top: 34, left: 0, zIndex: 20, width: 300, maxHeight: 280, overflowY: 'auto',
              background: '#fff', border: '1px solid #e3e6ea', borderRadius: 8, boxShadow: '0 4px 14px rgba(0,0,0,.12)' }}>
              {filteredMatches.map((s) => (
                <div key={s.code} onClick={() => choose(s)}
                  style={{ padding: '7px 10px', cursor: 'pointer', fontSize: 13, display: 'flex', justifyContent: 'space-between', gap: 8,
                    borderBottom: '1px solid #f2f4f7' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = '#f3f6fc')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = '#fff')}>
                  <span>{s.name}</span>
                  <span className="muted">{s.code}</span>
                </div>
              ))}
            </div>
          )}
          <button className="btn primary" onClick={addWatch} disabled={!picked && kw.trim().length !== 6}>+ 添加自选</button>
        </div>
        <table>
          <thead><tr><th>代码</th><th>名称</th><th>现价</th><th>涨跌幅</th><th>最高</th><th>最低</th><th>成交量(万手)</th><th>操作</th></tr></thead>
          <tbody>
            {wl.map((w) => { const q = quotes[w.code]; const cls = q ? fmt.cls(q.change_pct) : '';
              return <tr key={w.code}>
                <td>{w.code}</td><td>{q ? q.name : w.name}</td>
                <td className={cls}>{q ? fmt.price(q.price) : '--'}</td>
                <td className={cls}>{q ? fmt.pct(q.change_pct) : '--'}</td>
                <td className={cls}>{q ? fmt.price(q.high) : '--'}</td>
                <td className={cls}>{q ? fmt.price(q.low) : '--'}</td>
                <td>{q ? (q.volume / 10000).toFixed(1) : '--'}</td>
                <td><button className="btn" onClick={() => delWatch(w.code)}>删除</button></td>
              </tr>; })}
          </tbody>
        </table>
      </div>

      <div className="row">
        <div className="col panel" style={{ minWidth: 380 }}>
          <h3>🔔 预警规则</h3>
          <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
            <input value={al.code} onChange={(e) => setAl({ ...al, code: e.target.value.trim() })} style={{ width: 100 }} />
            <select value={al.type} onChange={(e) => setAl({ ...al, type: e.target.value })}><option value="price">价格</option><option value="change_pct">涨跌幅%</option></select>
            <select value={al.op} onChange={(e) => setAl({ ...al, op: e.target.value })}><option value="<=">≤</option><option value=">=">≥</option></select>
            <input type="number" value={al.value} onChange={(e) => setAl({ ...al, value: parseFloat(e.target.value) })} style={{ width: 80 }} />
            <button className="btn primary" onClick={addAlert}>+ 添加</button>
          </div>
          <table>
            <thead><tr><th>代码</th><th>条件</th><th>状态</th><th>备注</th><th></th></tr></thead>
            <tbody>{alerts.map((a) => <tr key={a.id}>
              <td>{a.code}</td><td>{a.type === 'price' ? '价格' : '涨跌'} {a.op} {a.value}</td>
              <td>{a.triggered ? <span className="tag" style={{ background: '#e23c3c' }}>已触发</span> : <span className="tag" style={{ background: '#9ca3af' }}>监控中</span>}</td>
              <td className="muted">{a.note || '-'}</td>
              <td><button className="btn" onClick={() => delAlert(a.id)}>删除</button></td>
            </tr>)}</tbody>
          </table>
        </div>
        <div className="col panel" style={{ minWidth: 300 }}>
          <h3>⚡ 触发提示 <span className="pill">10s 评估</span></h3>
          {hits.length ? hits.map((h, i) => (
            <div key={i} style={{ padding: '8px 10px', borderLeft: '3px solid #e23c3c', background: '#fff5f5', borderRadius: '0 6px 6px 0', marginBottom: 8 }}>
              <b>{h.name} {h.code}</b> 触发：{h.type === 'price' ? '价格' : '涨跌'} {h.op} {h.value}（当前 {h.current}）<span className="muted"> {h.lastHit}</span>
            </div>
          )) : <div className="muted">暂无触发</div>}
        </div>
      </div>
    </div>
  );
}
