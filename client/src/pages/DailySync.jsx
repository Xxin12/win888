import React, { useEffect, useState, useRef } from 'react';
import { api } from '../api';

const card = { background: 'var(--color-background-secondary)', border: '1px solid var(--color-border-tertiary)', borderRadius: 12, padding: 16, marginBottom: 16 };
const btn = (bg) => ({ padding: '8px 16px', borderRadius: 8, border: 'none', background: bg, color: '#fff', cursor: 'pointer', fontSize: 13, marginRight: 8 });
const thCell = { padding: '6px 8px', fontWeight: 600, whiteSpace: 'nowrap' };
const tdCell = { padding: '6px 8px', whiteSpace: 'nowrap' };

const PHASE = { init: '初始化', scanning: '探测交易日', syncing: '补齐中', skipped: '已跳过', done: '已完成', error: '异常' };

function ProgressBar({ p }) {
  if (!p) return null;
  const total = p.total || 0;
  const done = p.done || 0;
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : (p.phase === 'done' || p.phase === 'skipped' ? 100 : 0);
  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
        <span>阶段：<b>{PHASE[p.phase] || p.phase}</b>{p.current ? ` · 当前 ${p.current}` : ''}</span>
        <span>{done} / {total}（{pct}%）</span>
      </div>
      <div style={{ height: 16, background: 'var(--color-background-tertiary)', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--color-border-secondary)' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: 'linear-gradient(90deg,#3B6D11,#5BA832)', transition: 'width .3s', minWidth: pct ? 4 : 0 }} />
      </div>
      <div style={{ display: 'flex', gap: 18, fontSize: 12, marginTop: 8, color: 'var(--color-text-secondary)', flexWrap: 'wrap' }}>
        <span>日K +{p.dayAdded ?? 0}</span>
        <span>5分 +{p.m5Added ?? 0}</span>
        <span>分时 +{p.intradayDays ?? 0}日 / {p.intradayPoints ?? 0}点</span>
        <span style={{ color: (p.failed ?? 0) ? 'var(--color-text-danger)' : undefined }}>失败 {p.failed ?? 0}</span>
      </div>
    </div>
  );
}

function SummaryCard({ s }) {
  if (!s) return null;
  const dur = s.durationMs != null ? `${Math.round(s.durationMs / 1000)} 秒` : '-';
  return (
    <div style={card}>
      <h3 style={{ margin: '0 0 10px' }}>📋 最近一次补齐结果</h3>
      {s.skipped ? (
        <div style={{ color: 'var(--color-text-secondary)' }}>状态：<b>已跳过</b> — {s.reason || ''}</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px,1fr))', gap: 10, fontSize: 13 }}>
          <div>最新交易日：<b>{s.latestDay || '-'}</b></div>
          <div>处理股票：<b>{s.total}</b> 只</div>
          <div>日K 新增：<b style={{ color: 'var(--color-text-success)' }}>+{s.dayAdded}</b> 根</div>
          <div>5分钟 新增：<b style={{ color: 'var(--color-text-success)' }}>+{s.m5Added}</b> 根</div>
          <div>分时 新增：<b style={{ color: 'var(--color-text-success)' }}>+{s.intradayDays}</b> 日 / {s.intradayPoints} 点</div>
          <div>失败：<b style={{ color: (s.failed || 0) ? 'var(--color-text-danger)' : undefined }}>{s.failed || 0}</b> 只</div>
          <div>耗时：{dur}</div>
          <div>完成时间：{s.finishedAt ? s.finishedAt.replace('T', ' ').slice(0, 19) : '-'}</div>
        </div>
      )}
      {s.errors && s.errors.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--color-text-danger)' }}>失败样例：{s.errors.slice(0, 5).join('；')}</div>
      )}
    </div>
  );
}

export default function DailySync() {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [dryRun, setDryRun] = useState(false);
  const [scope, setScope] = useState('existing');
  const [idx, setIdx] = useState([]);
  const timer = useRef(null);

  const refresh = async () => {
    try { const r = await api.dailySyncStatus(); if (r && r.ok) setSt(r); } catch (_) {}
    try { const r = await api.indices(); if (r && r.ok) setIdx(r.indices || []); } catch (_) {}
  };

  useEffect(() => { refresh(); }, []);

  // 运行中 1.5s 轮询, 空闲 5s 轮询
  const running = !!(st && st.status && st.status.running);
  useEffect(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(refresh, running ? 1500 : 5000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [running]);

  const run = async () => {
    setBusy(true); setMsg('正在启动补齐任务…');
    const r = await api.dailySyncRun({ dryRun, scope });
    setBusy(false);
    if (r && r.started) { setMsg('任务已启动，进度见上方进度条'); refresh(); }
    else if (r && r.skipped) setMsg('已有任务在进行中，或该交易日已补齐');
    else setMsg('启动失败');
  };

  const progress = st && st.status && st.status.progress;
  const logs = (st && st.status && st.status.logs) || [];
  const lastResult = st && st.status && st.status.lastResult;
  const td = st && st.tradingDay;
  const lastProcessedDay = st && st.lastProcessedDay;
  const idxResult = running ? null : (lastResult || {});
  const showBar = running || (progress && ['done', 'skipped', 'error'].includes(progress.phase));

  return (
    <div style={{ padding: 20, maxWidth: 980 }}>
      <h2 style={{ margin: '0 0 4px' }}>🔄 每日行情数据补齐</h2>
      <div style={{ ...card, background: 'var(--color-background-info)', borderColor: 'var(--color-border-info)', fontSize: 13 }}>
        每个交易日收盘后由系统<b>自动触发补齐</b>（无需人工干预）。任务先对比本地与最新交易日数据，<b>只补齐本地缺失的最新数据</b>（日K / 5分钟 / 分时，幂等可重跑）。完成后自动推送企业微信汇总通知。也可在下方手动立即执行。
      </div>

      {/* 交易日信息 */}
      <div style={card}>
        <h3 style={{ margin: '0 0 8px' }}>交易日状态</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px,1fr))', gap: 10, fontSize: 13 }}>
          <div>最新交易日：<b>{td ? td.latestDay : '探测中…'}</b></div>
          <div>是否交易日：{td ? (td.isTradingDay ? <b style={{ color: 'var(--color-text-success)' }}>是</b> : <span style={{ color: 'var(--color-text-secondary)' }}>否（参考源）</span>) : '-'}</div>
          <div>参考标的：{td ? td.ref : '-'}</div>
          <div>本机已补齐至：<b>{lastProcessedDay || '（无记录）'}</b></div>
          <div>当前任务：{running ? <b style={{ color: 'var(--color-text-success)' }}>进行中</b> : <span style={{ color: 'var(--color-text-secondary)' }}>空闲</span>}</div>
        </div>
      </div>

      {/* 进度条 */}
      <div style={card}>
        <h3 style={{ margin: '0 0 8px' }}>执行进度{running ? '（实时）' : ''}</h3>
        {showBar ? (
          <ProgressBar p={progress} />
        ) : (
          <div style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>当前空闲，无进行中的任务。最近一次结果见下方汇总。</div>
        )}
      </div>

      {/* 结果汇总 */}
      <SummaryCard s={running ? null : lastResult} />

      {/* 大盘指数补齐 */}
      <div style={card}>
        <h3 style={{ margin: '0 0 8px' }}>📈 大盘指数补齐（每日自动）</h3>
        <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginBottom: 10 }}>
          大盘指数（上证指数 / 深证成指 / 沪深300 / 创业板指 等 <b>{idxResult.indexTotal || idx.length || 15}</b> 只）已纳入每日自动补齐：
          每个交易日收盘后由系统自动追平 <b>日K / 5分钟 / 分时</b>，无需手动操作。下面展示最近一次补齐的指数结果与各指数本地覆盖情况。
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px,1fr))', gap: 10, fontSize: 13, marginBottom: 12 }}>
          <div>指数总数：<b>{idxResult.indexTotal || idx.length || 15}</b> 只</div>
          <div>日K 新增：<b style={{ color: 'var(--color-text-success)' }}>+{idxResult.indexDayAdded || 0}</b> 根</div>
          <div>5分钟 新增：<b style={{ color: 'var(--color-text-success)' }}>+{idxResult.indexM5Added || 0}</b> 根</div>
          <div>分时 新增：<b style={{ color: 'var(--color-text-success)' }}>+{idxResult.indexIntradayDays || 0}</b> 日</div>
          <div>失败：<b style={{ color: (idxResult.indexFailed || 0) ? 'var(--color-text-danger)' : undefined }}>{idxResult.indexFailed || 0}</b> 只</div>
        </div>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 6 }}>本地覆盖情况（实时）：</div>
        <div style={{ maxHeight: 280, overflow: 'auto', border: '1px solid var(--color-border-secondary)', borderRadius: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--color-background-tertiary)', textAlign: 'left', position: 'sticky', top: 0 }}>
                <th style={thCell}>代码</th><th style={thCell}>名称</th><th style={thCell}>类别</th><th style={thCell}>日线</th><th style={thCell}>5分钟</th><th style={thCell}>分时</th>
              </tr>
            </thead>
            <tbody>
              {idx.map((x) => (
                <tr key={x.code} style={{ borderTop: '1px solid var(--color-border-secondary)' }}>
                  <td style={tdCell}>{x.code}</td>
                  <td style={tdCell}>{x.name}</td>
                  <td style={tdCell}>{x.category}</td>
                  <td style={tdCell}>{x.hasDay ? <span style={{ color: 'var(--color-text-success)' }}>✓</span> : <span style={{ color: 'var(--color-text-secondary)' }}>—</span>}</td>
                  <td style={tdCell}>{x.has5min ? <span style={{ color: 'var(--color-text-success)' }}>✓</span> : <span style={{ color: 'var(--color-text-secondary)' }}>—</span>}</td>
                  <td style={tdCell}>{x.intradayDates > 0 ? <span style={{ color: 'var(--color-text-success)' }}>{x.intradayDates}日</span> : <span style={{ color: 'var(--color-text-secondary)' }}>—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 执行日志 */}
      <div style={card}>
        <h3 style={{ margin: '0 0 8px' }}>执行日志（{running ? '每 1.5 秒刷新' : '最近一次运行'}）</h3>
        <pre style={{ background: 'var(--color-background-tertiary)', borderRadius: 8, padding: 12, fontSize: 12, maxHeight: 320, overflow: 'auto', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {logs.length ? logs.join('\n') : '（暂无日志）'}
        </pre>
      </div>

      {/* 手动触发 */}
      <div style={card}>
        <h3 style={{ margin: '0 0 8px' }}>手动执行</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <label style={{ fontSize: 13 }}><input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} /> 演练（只检查不写入）</label>
          <select value={scope} onChange={(e) => setScope(e.target.value)} style={{ padding: '6px 8px', borderRadius: 8, border: '1px solid var(--color-border-secondary)', background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)' }}>
            <option value="existing">仅补齐本地已有数据的股票</option>
            <option value="all">全市场补全最新一天</option>
          </select>
          <button style={{ ...btn('#185FA5') }} onClick={run} disabled={busy || running}>立即补齐</button>
          {msg && <span style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>{msg}</span>}
        </div>
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--color-text-secondary)' }}>
          说明：自动任务在<b>每个交易日收盘后（≥15:10）每 10 分钟</b>自动检查并补齐；同一交易日只跑一次。手动执行可随时触发，企业微信会在完成后推送汇总。
        </div>
      </div>
    </div>
  );
}
