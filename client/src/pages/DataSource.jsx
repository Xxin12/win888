import React, { useEffect, useState } from 'react';
import { api } from '../api';

const card = { background: 'var(--color-background-secondary)', border: '1px solid var(--color-border-tertiary)', borderRadius: 12, padding: 16, marginBottom: 16 };
const btn = (bg, disabled) => ({ padding: '8px 16px', borderRadius: 8, border: 'none', background: disabled ? 'var(--color-background-tertiary)' : bg, color: disabled ? 'var(--color-text-tertiary)' : '#fff', cursor: disabled ? 'default' : 'pointer', fontSize: 13, marginRight: 8 });
const chip = (active) => ({
  display: 'inline-block', padding: '3px 10px', borderRadius: 20, fontSize: 12, fontWeight: 500,
  border: '1px solid ' + (active ? 'var(--color-border-success, #3B6D11)' : 'var(--color-border-tertiary)'),
  background: active ? 'var(--color-background-success, #eaf5e0)' : 'transparent',
  color: active ? 'var(--color-text-success, #3B6D11)' : 'var(--color-text-secondary)',
});

// 能力状态徽章
const STATUS_BADGE = {
  fixed: { text: '固定源', bg: '#185FA5', color: '#fff' },
  switchable: { text: '✓ 可切换', bg: '#3B6D11', color: '#fff' },
  capable: { text: '△ 待接入', bg: '#b8860b', color: '#fff' },
  no: { text: '—', bg: '#9aa0a6', color: '#fff' },
};
const badge = (s) => {
  const m = STATUS_BADGE[s] || STATUS_BADGE.no;
  return (
    <span style={{ display: 'inline-block', padding: '1px 8px', borderRadius: 6, fontSize: 11, background: m.bg, color: m.color, whiteSpace: 'nowrap' }}>
      {m.text}
    </span>
  );
};

// 矩阵列(能力轴)顺序
const AXES = [
  { key: 'quote', label: '实时报价' },
  { key: 'day', label: '日K线' },
  { key: 'min5', label: '5分钟K线' },
  { key: 'intradayBackfill', label: '历史分时回补' },
  { key: 'intradayLive', label: '当日分时' },
];

export default function DataSource() {
  const [config, setConfig] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [channels, setChannels] = useState(null);
  const [liveIntraday, setLiveIntraday] = useState(null);
  const [msg, setMsg] = useState('');
  const [dirty, setDirty] = useState(false);
  // 测试
  const [testCode, setTestCode] = useState('sz002027');
  const [testing, setTesting] = useState(false);
  const [results, setResults] = useState(null);
  const [testTs, setTestTs] = useState('');
  // 通达信网关实时状态(用于"随系统启动"卡片展示)
  const [gwStatus, setGwStatus] = useState(null);

  useEffect(() => {
    api.dataSourceConfig().then((r) => {
      if (r && r.ok) {
        setConfig(r.config); setCatalog(r.catalog); setChannels(r.channels); setLiveIntraday(r.liveIntraday);
      }
    }).catch(() => setMsg('加载配置失败，请确认后端已重启'));
  }, []);

  const pick = (type, id) => { setConfig((c) => ({ ...c, [type]: id })); setDirty(true); setMsg(''); };
  const scrollTo = (type) => { const el = document.getElementById('ds-' + type); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); };

  const save = async () => {
    setMsg('保存中...');
    const r = await api.saveDataSourceConfig(config);
    if (r && r.ok) { setConfig(r.config); setDirty(false); setMsg('✅ 配置已保存，K线/分时接口即时生效'); }
    else setMsg('保存失败: ' + (r && r.error || ''));
  };

  const runTest = async () => {
    setTesting(true); setResults(null); setMsg('');
    const r = await api.dataSourceTest(testCode);
    setTesting(false);
    if (r && r.ok) { setResults(r.results); setTestTs(r.ts); }
    else setMsg('测试失败: ' + (r && r.error || ''));
  };

  // 通达信网关状态轮询(随系统启动卡片展示)
  useEffect(() => {
    let alive = true;
    const tick = () => api.tdxGatewayStatus().then((r) => { if (alive && r && r.ok) setGwStatus(r.data); }).catch(() => {});
    tick();
    const iv = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  if (!config || !catalog || !channels) return <div style={{ padding: 20 }}>加载中...{msg && <span style={{ color: 'var(--color-text-danger)' }}> {msg}</span>}</div>;

  const resByType = {};
  (results || []).forEach((x) => { (resByType[x.type] = resByType[x.type] || []).push(x); });

  return (
    <div style={{ padding: 20, maxWidth: 1040 }}>
      <h2 style={{ margin: '0 0 4px' }}>🗂️ 数据来源配置</h2>
      <div style={{ ...card, background: 'var(--color-background-info)', borderColor: 'var(--color-border-info)' }}>
        按数据类型选择行情来源。每个源标注了<b>经实测确认的能力范围与上限</b>，避免选到超出源能力的错误配置。
        修改后点「保存」即时生效（实时看盘的 K 线 / 5 分钟 / 历史分时回补会按此配置取数）。
      </div>

      {/* ============ 渠道能力总览矩阵 ============ */}
      <div style={card}>
        <h3 style={{ margin: '0 0 6px' }}>📡 渠道能力总览</h3>
        <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>
          每个渠道能提供的全部数据类型（单一注册表，与下方可选项实时同步）。
          <span style={{ marginLeft: 8 }}>{badge('switchable')}</span>
          <span style={{ marginLeft: 6 }}>{badge('fixed')}</span>
          <span style={{ marginLeft: 6 }}>{badge('capable')}</span>
          <span style={{ marginLeft: 6 }}>{badge('no')}</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--color-text-secondary)', borderBottom: '1px solid var(--color-border-tertiary)' }}>
                <th style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>渠道 \ 能力</th>
                {AXES.map((a) => <th key={a.key} style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{a.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {Object.values(channels).map((ch) => (
                <tr key={ch.id} style={{ borderBottom: '1px solid var(--color-border-tertiary)' }}>
                  <td style={{ padding: '6px 8px', fontWeight: 600, whiteSpace: 'nowrap' }}>{ch.name}</td>
                  {AXES.map((a) => {
                    const cap = ch.caps[a.key];
                    const st = cap ? cap.status : 'no';
                    const clickable = st === 'switchable';
                    return (
                      <td key={a.key} style={{ padding: '6px 8px', verticalAlign: 'top' }}>
                        <div
                          onClick={() => clickable ? scrollTo(a.key) : null}
                          style={{ cursor: clickable ? 'pointer' : 'default', display: 'inline-block' }}
                          title={cap ? (cap.note || cap.range) : '不支持'}
                        >
                          {badge(st)}
                          {st !== 'no' && cap.range ? (
                            <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 3, maxWidth: 150 }}>{cap.range}</div>
                          ) : null}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 6 }}>
          提示：标「△ 待接入」的能力该渠道技术上可服务，但 provider 尚未接通为可切换选项（如东财5分钟、TDX 日K/5分钟需扩展网关 category）；标「✓ 可切换」的格子可点击跳转到下方对应配置区。
        </div>
      </div>

      {/* ============ 各数据类型配置(由 CHANNELS 派生) ============ */}
      {Object.entries(catalog).map(([type, meta]) => (
        <div style={card} id={'ds-' + type} key={type}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
            <h3 style={{ margin: 0 }}>{meta.label}</h3>
            <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>{meta.desc}</span>
            {!meta.switchable && <span style={{ ...chip(false), marginLeft: 'auto' }}>唯一源·不可切换</span>}
          </div>
          <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
            {meta.options.map((opt) => {
              const active = config[type] === opt.id;
              return (
                <div
                  key={opt.id}
                  onClick={() => meta.switchable && pick(type, opt.id)}
                  style={{
                    border: '1px solid ' + (active ? 'var(--color-border-success, #3B6D11)' : 'var(--color-border-tertiary)'),
                    background: active ? 'var(--color-background-success, #f2f8ec)' : 'var(--color-background-primary, transparent)',
                    borderRadius: 10, padding: '10px 12px', cursor: meta.switchable ? 'pointer' : 'default',
                    display: 'grid', gridTemplateColumns: '18px 1fr', gap: 10, alignItems: 'start',
                  }}
                >
                  <div style={{ marginTop: 2 }}>
                    <span style={{
                      display: 'inline-block', width: 14, height: 14, borderRadius: '50%',
                      border: '2px solid ' + (active ? 'var(--color-border-success, #3B6D11)' : 'var(--color-border-secondary)'),
                      background: active ? 'var(--color-text-success, #3B6D11)' : 'transparent', boxSizing: 'border-box',
                    }} />
                  </div>
                  <div style={{ fontSize: 13 }}>
                    <div style={{ marginBottom: 3 }}>
                      <b>{opt.name}</b>
                      {opt.status === 'fixed' && <span style={{ ...chip(false), marginLeft: 8, padding: '1px 7px' }}>固定源</span>}
                      {active && <span style={{ ...chip(true), marginLeft: 8 }}>当前使用</span>}
                      <code style={{ marginLeft: 8, fontSize: 11, color: 'var(--color-text-tertiary)' }}>{opt.endpoint}</code>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', color: 'var(--color-text-secondary)', fontSize: 12 }}>
                      <span>📏 范围：<b style={{ color: 'var(--color-text-primary)' }}>{opt.range}</b></span>
                      {opt.anchor && <span>⚓ {opt.anchor}</span>}
                      {opt.unitCap && <span style={{ color: 'var(--color-text-warning, #b8860b)' }}>⚠️ {opt.unitCap}</span>}
                    </div>
                    <div style={{ color: 'var(--color-text-tertiary)', fontSize: 12, marginTop: 3 }}>字段：{opt.fields}</div>
                    <div style={{ color: 'var(--color-text-tertiary)', fontSize: 12, marginTop: 2 }}>{opt.note}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {/* 当日分时(实时) 说明(固定源) */}
      {liveIntraday && (
        <div style={card} id="ds-intradayLive">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <h3 style={{ margin: 0 }}>{liveIntraday.label}</h3>
            <span style={{ ...chip(false), marginLeft: 'auto' }}>固定源·不可切换</span>
          </div>
          <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginTop: 6 }}>
            <b>腾讯 minute/query</b> <code style={{ fontSize: 11 }}>{liveIntraday.endpoint}</code>
            <div style={{ marginTop: 3 }}>📏 {liveIntraday.range} · 字段：{liveIntraday.fields}</div>
            <div style={{ color: 'var(--color-text-tertiary)', marginTop: 2 }}>{liveIntraday.note}</div>
          </div>
        </div>
      )}

      {/* 东财节点(host) 覆盖 */}
      <div style={card} id="ds-emNode">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
          <h3 style={{ margin: 0 }}>东财节点（host 覆盖）</h3>
          <span style={{ ...chip(false), marginLeft: 'auto' }}>仅影响东财源</span>
        </div>
        <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
          部分网络仅 <code style={{ fontSize: 11 }}>push2.eastmoney.com</code> / <code style={{ fontSize: 11 }}>push2his.eastmoney.com</code> 被拦截。若你有可用镜像，填入主机（如 <code style={{ fontSize: 11 }}>82.push2.eastmoney.com</code>）；留空或 <code style={{ fontSize: 11 }}>auto</code> 用默认节点。
          本环境实测：push2/push2his 被拦截，<code style={{ fontSize: 11 }}>datacenter.eastmoney.com</code> 可达但不提供行情接口，故东财源在此不可用，请改用腾讯/新浪或「本地快照」。
        </div>
        <input
          value={config.emNode || 'auto'}
          onChange={(e) => { setConfig((c) => ({ ...c, emNode: e.target.value })); setDirty(true); setMsg(''); }}
          placeholder="auto 或自定义主机, 如 82.push2.eastmoney.com"
          style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--color-border-secondary)', background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)', fontSize: 13, width: 380 }}
        />
      </div>

      {/* 通达信网关: 随系统启动 */}
      <div style={card} id="ds-tdxGateway">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
          <h3 style={{ margin: 0 }}>🧩 通达信网关（随系统启动）</h3>
          <span style={{ ...chip(!!(gwStatus && gwStatus.running)), marginLeft: 'auto' }}>{gwStatus && gwStatus.running ? '运行中' : '未运行'}</span>
        </div>
        <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginBottom: 10 }}>
          通达信(TDX)是<b>回看历史分时 / 多年日K / 5分钟</b>的免费源，但需先启动本地 pytdx 网关。
          上方「日K线 / 5分钟 / 历史分时回补」选 TDX 后，只有网关运行才真正生效。
          开启下方开关，本服务启动时会<b>自动拉起网关</b>，TDX 选项即开箱可用。
          网关参数（TDX 主机 / Token / 端口）请在左侧「🧩 TDX 网关」页配置。
        </div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={!!config.tdxAutoStart}
            onChange={(e) => { setConfig((c) => ({ ...c, tdxAutoStart: e.target.checked })); setDirty(true); setMsg(''); }}
          />
          随系统启动自动拉起 TDX 网关
        </label>
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--color-text-tertiary)' }}>
          {gwStatus ? (
            gwStatus.running
              ? `当前网关运行中（pid ${gwStatus.pid}${gwStatus.endpoint ? '，endpoint ' + gwStatus.endpoint : ''}）`
              : '当前网关未运行。保存并重启服务后，若已开启「随系统启动」且依赖齐全，将自动拉起；也可在「🧩 TDX 网关」页手动启动。'
          ) : '状态加载中...'}
        </div>
      </div>

      <div style={{ marginBottom: 20 }}>
        <button style={btn('#3B6D11', !dirty)} onClick={save} disabled={!dirty}>保存配置</button>
        {msg && <span style={{ marginLeft: 6, color: 'var(--color-text-secondary)', fontSize: 13 }}>{msg}</span>}
      </div>

      {/* 接口实测 */}
      <div style={card}>
        <h3 style={{ margin: '0 0 8px' }}>🔬 接口实测（确认真实数据范围）</h3>
        <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginBottom: 10 }}>
          输入一只股票，逐个真实调用所有数据源，返回实测条数 / 日期范围 / 交易日数 / 耗时。
          <b>东财 push2his 在部分受限网络会连接失败（属网络环境问题，本机通常可用）。</b>
        </div>
        <input
          value={testCode} onChange={(e) => setTestCode(e.target.value)}
          placeholder="如 002027 / sh600519"
          style={{ padding: '7px 9px', borderRadius: 8, border: '1px solid var(--color-border-secondary)', background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)', fontSize: 13, width: 200, marginRight: 8 }}
        />
        <button style={btn('#185FA5', testing)} onClick={runTest} disabled={testing}>{testing ? '测试中...' : '测试全部接口'}</button>
        {testTs && <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--color-text-tertiary)' }}>{new Date(testTs).toLocaleString('zh-CN', { hour12: false })}</span>}

        {results && (
          <div style={{ marginTop: 14, overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--color-text-secondary)', borderBottom: '1px solid var(--color-border-tertiary)' }}>
                  <th style={{ padding: '6px 8px' }}>数据类型</th>
                  <th style={{ padding: '6px 8px' }}>数据源</th>
                  <th style={{ padding: '6px 8px' }}>状态</th>
                  <th style={{ padding: '6px 8px' }}>实测结果</th>
                  <th style={{ padding: '6px 8px' }}>耗时</th>
                </tr>
              </thead>
              <tbody>
                {results.map((x, i) => {
                  const isCurrent = config[x.type] === x.source;
                  return (
                    <tr key={i} style={{ borderBottom: '1px solid var(--color-border-tertiary)' }}>
                      <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{x.typeLabel}</td>
                      <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                        {x.sourceName}
                        {isCurrent && <span style={{ ...chip(true), marginLeft: 6, padding: '1px 6px' }}>用</span>}
                      </td>
                      <td style={{ padding: '6px 8px' }}>
                        <span style={{ color: x.ok ? 'var(--color-text-success)' : 'var(--color-text-danger)', fontWeight: 600 }}>
                          {x.ok ? '● 正常' : '● 失败'}
                        </span>
                      </td>
                      <td style={{ padding: '6px 8px', color: x.ok ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)' }}>
                        {x.detail}
                        {!x.ok && x.error && <div style={{ color: 'var(--color-text-danger)', fontSize: 11, marginTop: 2 }}>{x.error}</div>}
                      </td>
                      <td style={{ padding: '6px 8px', color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>{x.ms}ms</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
