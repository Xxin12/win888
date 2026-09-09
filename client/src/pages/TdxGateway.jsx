import React, { useEffect, useState, useRef } from 'react';
import { api } from '../api';

const labelStyle = { display: 'block', margin: '10px 0 4px', fontWeight: 500, fontSize: 13 };
const inputStyle = { width: '100%', padding: '7px 9px', borderRadius: 8, border: '1px solid var(--color-border-secondary)', background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)', fontSize: 13, boxSizing: 'border-box' };
const btn = (bg) => ({ padding: '8px 16px', borderRadius: 8, border: 'none', background: bg, color: '#fff', cursor: 'pointer', fontSize: 13, marginRight: 8 });
const card = { background: 'var(--color-background-secondary)', border: '1px solid var(--color-border-tertiary)', borderRadius: 12, padding: 16, marginBottom: 16 };

export default function TdxGateway() {
  const [cfg, setCfg] = useState(null);
  const [status, setStatus] = useState(null);
  const [deps, setDeps] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [cfgErr, setCfgErr] = useState('');
  const timer = useRef(null);

  // 任一请求失败都不应让页面永远停在「加载中」
  const refresh = async () => {
    const [s, d] = await Promise.allSettled([api.tdxGatewayStatus(), api.tdxGatewayDeps()]);
    setStatus(s.status === 'fulfilled' && s.value ? (s.value.data || null) : null);
    setDeps(d.status === 'fulfilled' && d.value ? (d.value.data || null) : null);
  };

  useEffect(() => {
    let alive = true;
    api.tdxGatewayConfig()
      .then((r) => { if (alive) setCfg(r && r.data ? r.data : {}); })
      .catch((e) => { if (alive) { setCfg({}); setCfgErr('加载配置失败: ' + (e && e.message ? e.message : '请求无响应，请确认服务已重启并刷新')); } });
    refresh();
    timer.current = setInterval(refresh, 3000);
    return () => { alive = false; clearInterval(timer.current); };
  }, []);

  const set = (k, v) => setCfg((c) => ({ ...c, [k]: v }));

  const save = async () => {
    setBusy(true); setMsg('保存中...');
    const r = await api.saveTdxGatewayConfig(cfg);
    setBusy(false);
    setMsg(r.ok ? '配置已保存' : ('保存失败: ' + (r.error || '')));
  };

  const start = async () => {
    setBusy(true); setMsg('正在启动网关...');
    const r = await api.startTdxGateway();
    setBusy(false);
    if (r.ok) setMsg(r.endpoint ? ('网关已启动, 端点 ' + r.endpoint + (r.warn ? ' (' + r.warn + ')' : '')) : ('已启动(pid=' + r.pid + '), 但未连通Healthz: ' + (r.warn || '')));
    else setMsg('启动失败: ' + (r.reason || ''));
    refresh();
  };

  const stop = async () => {
    const r = await api.stopTdxGateway();
    setMsg(r.stopped ? ('已停止网关(pid=' + r.pid + ')') : (r.reason || '未在运行'));
    refresh();
  };

  const checkDeps = async () => {
    setMsg('检测依赖中...');
    const r = await api.tdxGatewayDeps();
    setDeps(r.data || null);
    setMsg('');
  };

  if (!cfg) return <div style={{ padding: 20 }}>加载中...</div>;

  const running = status && status.running;
  const connected = status && status.health && status.health.connected;

  return (
    <div style={{ padding: 20, maxWidth: 920 }}>
      <h2 style={{ margin: '0 0 4px' }}>🔌 TDX 网关管理</h2>
      <div style={{ ...card, background: 'var(--color-background-info)', borderColor: 'var(--color-border-info)' }}>
        ⚠️ 本功能通过 Web 拉起本机 Python 子进程（pytdx 网关），<b>仅限本机开发环境使用，切勿公网暴露本服务</b>。
        启动后「实时看盘 → 从通daxin回补」按钮即生效。
      </div>

      {cfgErr && (
        <div style={{ ...card, background: 'var(--color-background-danger, #fde8e8)', borderColor: 'var(--color-border-danger, #e0a0a0)' }}>
          ⚠️ {cfgErr}
          <div style={{ marginTop: 6, fontSize: 12, color: 'var(--color-text-secondary)' }}>
            最常见原因：后端服务进程是旧代码启动的（尚未包含 /api/tdx-gateway 路由）。请在 quant-web 目录下<code style={{ background: 'var(--color-background-tertiary)', padding: '1px 5px', borderRadius: 5 }}> 停止并重启 node server/index.js </code>，然后浏览器强制刷新（Ctrl/Cmd + Shift + R）。
          </div>
        </div>
      )}

      {/* 依赖检测 */}
      <div style={card}>
        <h3 style={{ margin: '0 0 8px' }}>运行环境依赖</h3>
        <button style={btn('#185FA5')} onClick={checkDeps}>检查 python / pytdx</button>
        {deps && (
          <div style={{ marginTop: 10, fontSize: 13 }}>
            <div>Python 解释器: <b>{deps.python || '未找到'}</b></div>
            {[
              ['pytdx', deps.pytdx],
              ['fastapi', deps.fastapi],
              ['uvicorn', deps.uvicorn],
            ].map(([name, ok]) => (
              <div key={name}>
                {name} 库: <b style={{ color: ok ? 'var(--color-text-success)' : 'var(--color-text-danger)' }}>{ok ? '已安装' : '未安装'}</b>
              </div>
            ))}
            {!deps.allOk && (
              <div style={{ marginTop: 6, color: 'var(--color-text-secondary)' }}>
                缺失时请在本机该 Python 下执行（建议先建虚拟环境）：<br />
                <code style={{ background: 'var(--color-background-tertiary)', padding: '2px 6px', borderRadius: 6 }}>
                  pip install -r server/gateway/requirements.txt
                </code>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 参数配置 */}
      <div style={card}>
        <h3 style={{ margin: '0 0 8px' }}>网关参数</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={labelStyle}>监听端口 PORT</label>
            <input style={inputStyle} type="number" value={cfg.PORT ?? ''} onChange={(e) => set('PORT', e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>绑定地址 BIND</label>
            <input style={inputStyle} value={cfg.BIND ?? ''} onChange={(e) => set('BIND', e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>鉴权 Token (TDX_TOKEN, 可选)</label>
            <input style={inputStyle} value={cfg.TDX_TOKEN ?? ''} onChange={(e) => set('TDX_TOKEN', e.target.value)} placeholder="建议设置, 网关侧启用了则必填" />
          </div>
          <div>
            <label style={labelStyle}>Python 路径 (PYTHON_BIN, 留空自动探测)</label>
            <input style={inputStyle} value={cfg.PYTHON_BIN ?? ''} onChange={(e) => set('PYTHON_BIN', e.target.value)} placeholder="如 python / python3" />
          </div>
          <div>
            <label style={labelStyle}>请求节流 TDX_REQUEST_GAP_MS</label>
            <input style={inputStyle} type="number" value={cfg.TDX_REQUEST_GAP_MS ?? ''} onChange={(e) => set('TDX_REQUEST_GAP_MS', e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>失败重试 TDX_MAX_RETRY</label>
            <input style={inputStyle} type="number" value={cfg.TDX_MAX_RETRY ?? ''} onChange={(e) => set('TDX_MAX_RETRY', e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>缓存上限 TDX_CACHE_MAX</label>
            <input style={inputStyle} type="number" value={cfg.TDX_CACHE_MAX ?? ''} onChange={(e) => set('TDX_CACHE_MAX', e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>公共节点 TDX_HOSTS (可选, 逗号分隔)</label>
            <input style={inputStyle} value={cfg.TDX_HOSTS ?? ''} onChange={(e) => set('TDX_HOSTS', e.target.value)} placeholder="ip:port,ip:port" />
          </div>
        </div>
        <button style={{ ...btn('#3B6D11'), marginTop: 14 }} onClick={save} disabled={busy}>保存配置</button>
      </div>

      {/* 启停 + 状态 */}
      <div style={card}>
        <h3 style={{ margin: '0 0 8px' }}>控制</h3>
        <button style={btn('#0F6E56')} onClick={start} disabled={busy || running}>启动网关</button>
        <button style={btn('#A32D2D')} onClick={stop} disabled={!running}>停止网关</button>
        {msg && <span style={{ marginLeft: 10, color: 'var(--color-text-secondary)' }}>{msg}</span>}

        {status && (
          <div style={{ marginTop: 14, fontSize: 13, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div>状态: <b style={{ color: running ? 'var(--color-text-success)' : 'var(--color-text-danger)' }}>{running ? '运行中' : '已停止'}</b></div>
            <div>连通: <b style={{ color: connected ? 'var(--color-text-success)' : 'var(--color-text-danger)' }}>{connected ? '是' : '否'}</b></div>
            <div>PID: {status.pid ?? '-'}</div>
            <div>运行时长: {status.uptimeSec ? status.uptimeSec + 's' : '-'}</div>
            <div>端点: {status.endpoint || '-'}</div>
            <div>连接节点: {status.health && status.health.host ? status.health.host : '-'}</div>
          </div>
        )}
      </div>

      {/* 日志 */}
      <div style={card}>
        <h3 style={{ margin: '0 0 8px' }}>运行日志（每 3 秒刷新）</h3>
        <pre style={{ background: 'var(--color-background-tertiary)', borderRadius: 8, padding: 12, fontSize: 12, maxHeight: 280, overflow: 'auto', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {(status && status.logs && status.logs.length) ? status.logs.join('\n') : '（暂无日志）'}
        </pre>
      </div>
    </div>
  );
}
