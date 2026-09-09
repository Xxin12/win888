import React, { useEffect, useState } from 'react';
import { api, fmt } from '../api';

export default function News() {
  const [code, setCode] = useState('sz002027');
  const [f10, setF10] = useState(null);
  const [news, setNews] = useState([]);
  const [ff, setFf] = useState([]);

  const load = () => {
    api.f10(code).then((r) => setF10(r.data || null));
    api.news(code).then((r) => setNews(r.data || []));
    api.fundflow(code).then((r) => setFf(r.data || []));
  };
  useEffect(() => { load(); }, [code]);

  return (
    <div>
      <div className="panel">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input value={code} onChange={(e) => setCode(e.target.value.trim())} style={{ width: 130 }} />
          <button className="btn primary" onClick={load}>查询</button>
          <span className="muted">资讯/F10/资金流（腾讯源，部分为 best-effort）</span>
        </div>
      </div>

      <div className="row">
        <div className="col panel" style={{ minWidth: 320 }}>
          <h3>📊 F10 / 估值快照</h3>
          {f10 ? <table><tbody>
            <tr><td>名称</td><td>{f10.name}</td></tr>
            <tr><td>现价</td><td>{fmt.price(f10.price)}</td></tr>
            <tr><td>今开 / 昨收</td><td>{fmt.price(f10.open)} / {fmt.price(f10.preclose)}</td></tr>
            <tr><td>最高 / 最低</td><td>{fmt.price(f10.high)} / {fmt.price(f10.low)}</td></tr>
            <tr><td>市盈率(动)</td><td>{f10.pe ?? '--'}</td></tr>
            <tr><td>换手率</td><td>{f10.turnover != null ? f10.turnover + '%' : '--'}</td></tr>
            <tr><td>总市值(亿)</td><td>{f10.market_cap ?? '--'}</td></tr>
            <tr><td>流通市值(亿)</td><td>{f10.float_cap ?? '--'}</td></tr>
          </tbody></table> : <div className="muted">加载中…</div>}
        </div>
        <div className="col panel" style={{ minWidth: 320 }}>
          <h3>💰 资金流</h3>
          {ff && ff.length ? <table><thead><tr><th>日期</th><th>主力净流入</th></tr></thead>
            <tbody>{ff.slice(-10).map((x, i) => <tr key={i}><td>{Array.isArray(x) ? x[0] : x.date}</td><td className={fmt.cls(Array.isArray(x) ? +x[1] : x.main)}>{fmt.money(Array.isArray(x) ? +x[1] : x.main)}</td></tr>)}</tbody>
          </table> : <div className="muted">资金流接口暂无数据（可由助手 MCP 落盘补充）。</div>}
        </div>
      </div>

      <div className="panel">
        <h3>📰 新闻公告</h3>
        {news && news.length ? news.map((n, i) => (
          <div key={i} style={{ padding: '8px 0', borderBottom: '1px solid #eee' }}>
            <a href={n.url || '#'} target="_blank" rel="noreferrer">{n.title}</a>
            <span className="muted" style={{ marginLeft: 8 }}>{n.time || n.date}</span>
          </div>
        )) : <div className="muted">本地暂无新闻缓存。可让助手用腾讯自选股 MCP 拉取新闻/公告落盘到 data/stocks/&lt;code&gt;_news.json。</div>}
      </div>
    </div>
  );
}
