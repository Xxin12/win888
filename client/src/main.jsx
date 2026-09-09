import React, { useEffect, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import ErrorBoundary from './ErrorBoundary';
import { api, connectQuotes } from './api';
import Market from './pages/Market';
import Quotes from './pages/Quotes';
import Watchlist from './pages/Watchlist';
import Backtest from './pages/Backtest';
import Portfolio from './pages/Portfolio';
import News from './pages/News';
import Wecom from './pages/Wecom';
import TdxGateway from './pages/TdxGateway';
import DataSource from './pages/DataSource';
import DailySync from './pages/DailySync';
import LocalData from './pages/LocalData';
import DoTAnalysis from './pages/DoTAnalysis';

const PAGES = [
  { key: 'market', label: '📈 实时看盘', comp: Market },
  { key: 'quotes', label: '📊 行情中心', comp: Quotes },
  { key: 'watchlist', label: '⭐ 自选监控', comp: Watchlist },
  { key: 'datasource', label: '🗂️ 数据源配置', comp: DataSource },
  { key: 'backfill', label: '🧩 TDX 网关', comp: TdxGateway },
  { key: 'backtest', label: '🧪 策略回测', comp: Backtest },
  { key: 'portfolio', label: '💼 组合持仓', comp: Portfolio },
  { key: 'news', label: '📰 资讯F10', comp: News },
  { key: 'wecom', label: '🔔 企微通知', comp: Wecom },
  { key: 'dailysync', label: '🔄 每日补齐', comp: DailySync },
  { key: 'localdata', label: '🗄️ 本地数据', comp: LocalData },
  { key: 'dot', label: '🎯 做T分析', comp: DoTAnalysis },
];

function App() {
  // 兼容 #wecom 与 #/wecom 两种写法
  const [page, setPage] = useState(location.hash.replace(/^#\/?/, '') || 'market');
  const [quotes, setQuotes] = useState({}); // code -> quote
  const [live, setLive] = useState(false);
  const [ts, setTs] = useState('');
  const [portfolio, setPortfolio] = useState([]);
  const [restarting, setRestarting] = useState(false);
  const connRef = useRef(null);

  useEffect(() => {
    api.portfolio().then((r) => setPortfolio((r.data || []).map((x) => ({ code: x.code, cost: x.cost, name: x.name }))));
    const conn = connectQuotes((msg) => {
      if (msg.type === 'hello' && msg.snapshot) mergeQuotes(msg.snapshot);
      if (msg.type === 'quotes') { mergeQuotes(msg.data); setLive(!!msg.live); setTs(msg.ts || ''); }
      if (msg.type === 'error') { setLive(false); if (msg.data) mergeQuotes(msg.data); }
    });
    connRef.current = conn;
    // 订阅自选+持仓
    Promise.all([api.watchlist(), api.portfolio()]).then(([w, p]) => {
      const codes = [...new Set([...(w.data || []).map((x) => x.code), ...(p.data || []).map((x) => x.code)])];
      setTimeout(() => conn.subscribe(codes), 500);
    });
    return () => conn.close();
  }, []);

  const mergeQuotes = (arr) => setQuotes((prev) => { const n = { ...prev }; arr.forEach((q) => (n[q.code] = q)); return n; });

  // 构建版本轮询: 检测到新构建(服务端 .version 变化)或本页无版本号(旧 bundle)则自动刷新,
  // 避免跨轮跑旧 bundle。重载后页面即带新版本号, 不会再重复触发。
  useEffect(() => {
    const BUILD_VER = window.__APP_VERSION__ || null;
    const t = setInterval(() => {
      fetch('/api/version?_=' + Date.now()).then((r) => r.json()).then((d) => {
        if (!d || !d.ok || !d.version) return;
        if (!BUILD_VER || String(d.version) !== String(BUILD_VER)) location.reload();
      }).catch(() => {});
    }, 15000);
    return () => clearInterval(t);
  }, []);

  // 重启整个系统: 调接口触发后端自重启, 期间轮询 ping, 新进程就绪后自动刷新页面
  const doRestart = async () => {
    if (restarting) return;
    if (!window.confirm('确定要重启整个量化系统吗？\n重启期间服务会短暂中断（约几秒），页面将自动刷新。')) return;
    setRestarting(true);
    try { await api.systemRestart(); } catch (_) {}
    let tries = 0;
    const tick = async () => {
      tries++;
      if (tries > 45) { setRestarting(false); window.location.reload(); return; } // 兜底: 直接刷新
      try {
        const r = await api.ping();
        if (r && r.ok) { window.location.reload(); return; }
      } catch (_) {}
      setTimeout(tick, 2000);
    };
    setTimeout(tick, 2500);
  };

  const go = (k) => { setPage(k); location.hash = k; };
  const Comp = (PAGES.find((p) => p.key === page) || PAGES[0]).comp;

  return (
    <>
    <div className="app">
      <div className="side">
        <div className="logo">简易量化系统<small>Tongdaxin + 腾讯自选股</small></div>
        <div className="nav">
          {PAGES.map((p) => <a key={p.key} className={page === p.key ? 'active' : ''} onClick={() => go(p.key)}>{p.label}</a>)}
        </div>
      </div>
      <div className="main">
        <div className="topbar">
          <span style={{ fontWeight: 600 }}>{(PAGES.find((p) => p.key === page) || {}).label}</span>
          <span className="status" style={{ marginLeft: 'auto' }}>
            <span className={'dot ' + (live ? 'live' : 'stale')} />
            {live ? '实时行情连接中' : '行情延迟/降级'} {ts && <span className="muted">· {ts}</span>}
          </span>
          <button className="btn btn-restart" onClick={doRestart} disabled={restarting} title="重启整个量化系统">
            🔄 重启系统
          </button>
        </div>
        <div className="content">
          <Comp quotes={quotes} portfolio={portfolio} />
        </div>
      </div>
      </div>
      {restarting && (
        <div className="overlay-restart">
          <div className="restart-box">
            <div className="spinner" />
            <div className="rb-title">服务正在重启中…</div>
            <div className="muted">旧进程退出、新进程接管端口，预计几秒后页面自动刷新。</div>
          </div>
        </div>
      )}
    </>
  );
}

createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
