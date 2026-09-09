import React, { useEffect, useState, useRef } from 'react';
import { api, normCode } from '../api';

// 行内编辑 / 新增时, 数字类型用 number 输入框
const NUMERIC = /INT|REAL|FLOAT|NUMBER|DOUBLE|DECIMAL|NUMERIC/i;

export default function LocalData() {
  const [scope, setScope] = useState('global'); // 'global' | 'stock'
  const [code, setCode] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [stockCodes, setStockCodes] = useState([]);
  const [stockFilter, setStockFilter] = useState('');
  const [tables, setTables] = useState([]);
  const [activeTable, setActiveTable] = useState('');
  const [data, setData] = useState(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [editingKey, setEditingKey] = useState(null);
  const [editDraft, setEditDraft] = useState({});
  const [showAdd, setShowAdd] = useState(false);
  const [addDraft, setAddDraft] = useState({});
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  // 加载已存在的个股 .db 列表(一次性)
  useEffect(() => {
    api.dbStocks().then((r) => { if (r && r.ok) setStockCodes(r.codes || []); }).catch(() => {});
  }, []);

  const flash = (m, isErr) => { setMsg(m); if (isErr) console.warn(m); };

  // 切换 scope/code 时加载表清单
  const loadTables = async (sc, cd) => {
    setBusy(true);
    try {
      const r = await api.dbTables(sc, cd);
      if (r && r.ok) { setTables(r.tables || []); setActiveTable(''); setData(null); }
      else flash('加载表失败: ' + (r && r.error), true);
    } catch (e) { flash('加载表异常: ' + e.message, true); }
    finally { setBusy(false); }
  };

  const loadRows = async () => {
    if (!activeTable) return;
    setBusy(true);
    try {
      const r = await api.dbRows(scope, code, activeTable, page, pageSize, search);
      if (r && r.ok) setData(r);
      else flash('加载行失败: ' + (r && r.error), true);
    } catch (e) { flash('加载行异常: ' + e.message, true); }
    finally { setBusy(false); }
  };

  // 选 scope
  const pickGlobal = () => { setScope('global'); setCode(''); loadTables('global', ''); };
  const openStock = (raw) => {
    let nc = raw;
    try { nc = normCode(raw); } catch (e) { flash('代码格式错误: ' + e.message, true); return; }
    setScope('stock'); setCode(nc); setCodeInput(nc); loadTables('stock', nc);
  };

  useEffect(() => { if (activeTable) loadRows(); /* eslint-disable-next-line */ }, [activeTable, page, pageSize]);

  const doSearch = () => { setPage(1); setTimeout(loadRows, 0); };
  const changePage = (p) => { if (p < 1) return; setPage(p); };

  // ---- 编辑 ----
  const startEdit = (row) => { setEditingKey(JSON.stringify(row._pk)); const d = {}; for (const k in row) if (k !== '_pk') d[k] = row[k] == null ? '' : row[k]; setEditDraft(d); };
  const cancelEdit = () => { setEditingKey(null); setEditDraft({}); };
  const saveEdit = async (row) => {
    setBusy(true);
    try {
      const r = await api.dbUpdate(scope, code, activeTable, row._pk, editDraft);
      if (r && r.ok) { flash('已保存'); setEditingKey(null); setEditDraft({}); await loadRows(); }
      else flash('保存失败: ' + (r && r.error), true);
    } catch (e) { flash('保存异常: ' + e.message, true); }
    finally { setBusy(false); }
  };

  // ---- 删除 ----
  const delRow = async (row) => {
    if (!window.confirm('确认删除该行？此操作直接修改本地数据库且不可撤销。')) return;
    setBusy(true);
    try {
      const r = await api.dbDelete(scope, code, activeTable, row._pk);
      if (r && r.ok) { flash('已删除 ' + (r.changes || 0) + ' 行'); await loadRows(); }
      else flash('删除失败: ' + (r && r.error), true);
    } catch (e) { flash('删除异常: ' + e.message, true); }
    finally { setBusy(false); }
  };

  // ---- 新增 ----
  const openAdd = () => { const d = {}; (data ? data.columns : []).forEach((c) => (d[c.name] = '')); setAddDraft(d); setShowAdd(true); };
  const saveAdd = async () => {
    setBusy(true);
    try {
      const r = await api.dbInsert(scope, code, activeTable, addDraft);
      if (r && r.ok) { flash('已新增'); setShowAdd(false); setPage(1); await loadRows(); }
      else flash('新增失败: ' + (r && r.error), true);
    } catch (e) { flash('新增异常: ' + e.message, true); }
    finally { setBusy(false); }
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;
  const filteredStockCodes = stockCodes.filter((c) => c.includes(stockFilter.trim().toLowerCase()));

  return (
    <div style={{ padding: 18, display: 'flex', gap: 16, alignItems: 'flex-start' }}>
      {/* 左侧: 数据库 / 表 选择 */}
      <div style={{ width: 240, flex: '0 0 240px' }}>
        <div className="panel" style={{ padding: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>🗄️ 本地数据库</div>
          <button className={'btn' + (scope === 'global' ? ' primary' : '')} style={{ width: '100%', marginBottom: 10, textAlign: 'left' }} onClick={pickGlobal}>
            🌐 全局数据库
          </button>
          <div style={{ fontSize: 12, color: 'var(--sub)', marginBottom: 6 }}>个股数据库（每只股票一个 .db）</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <input
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') openStock(codeInput); }}
              placeholder="股票代码 如 600001"
              style={{ flex: 1, minWidth: 0 }}
            />
            <button className="btn primary" onClick={() => openStock(codeInput)}>打开</button>
          </div>
          <input
            value={stockFilter}
            onChange={(e) => setStockFilter(e.target.value)}
            placeholder="筛选已有个股库…"
            style={{ width: '100%', marginBottom: 8, fontSize: 12 }}
          />
          <div style={{ maxHeight: 320, overflow: 'auto', borderTop: '1px solid var(--line)' }}>
            {filteredStockCodes.length === 0 && <div style={{ fontSize: 12, color: 'var(--sub)', padding: '8px 2px' }}>（无匹配，可在上方直接打开任意代码）</div>}
            {filteredStockCodes.map((c) => (
              <div
                key={c}
                onClick={() => openStock(c)}
                style={{ padding: '6px 8px', fontSize: 13, cursor: 'pointer', borderRadius: 6, background: scope === 'stock' && code === c ? 'var(--accent)' : 'transparent', color: scope === 'stock' && code === c ? '#fff' : 'var(--ink)' }}
              >
                {c}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 右侧: 表清单 或 表数据 */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {!activeTable ? (
          <div className="panel">
            <h3>{scope === 'global' ? '🌐 全局数据库 (global.db)' : `📈 个股数据库 ${code || ''}`}</h3>
            <div className="muted" style={{ marginBottom: 10 }}>
              选择一个表查看与编辑。所有写操作直接作用于本地 SQLite，请谨慎。
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
              {tables.map((t) => (
                <div key={t.name} onClick={() => { setActiveTable(t.name); setPage(1); }} className="panel" style={{ margin: 0, cursor: 'pointer', borderColor: 'var(--line)' }}>
                  <div style={{ fontWeight: 600 }}>{t.name}</div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>行数：{t.rowCount != null ? t.rowCount : '—'}</div>
                  <div style={{ marginTop: 6, fontSize: 11, color: 'var(--sub)' }}>
                    {t.columns.map((c) => c.name + (c.pk ? '🔑' : '')).join(' · ')}
                  </div>
                </div>
              ))}
              {tables.length === 0 && <div className="muted">（暂无表）</div>}
            </div>
          </div>
        ) : (
          <div className="panel">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
              <h3 style={{ margin: 0 }}>表：{activeTable}{scope === 'stock' ? ` · ${code}` : ''}</h3>
              <span className="muted">共 {data ? data.total : 0} 行</span>
              <span className="pill">{scope === 'global' ? 'global.db' : code + '.db'}</span>
              <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => loadRows()}>🔄 刷新</button>
              <button className="btn primary" onClick={openAdd}>➕ 新增行</button>
            </div>

            {/* 字段结构 */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
              {data && data.columns.map((c) => (
                <span key={c.name} className="pill" title={c.type + (c.pk ? ' · 主键' : '')}>
                  {c.name}{c.pk ? ' 🔑' : ''} <span style={{ color: 'var(--sub)' }}>{c.type}</span>
                </span>
              ))}
            </div>

            {/* 搜索 / 分页控制 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') doSearch(); }}
                placeholder="搜索任意字段…"
                style={{ flex: 1, minWidth: 160 }}
              />
              <button className="btn" onClick={doSearch}>搜索</button>
              <button className="btn" onClick={() => { setSearch(''); setPage(1); setTimeout(loadRows, 0); }}>清除</button>
              <label className="muted" style={{ fontSize: 12 }}>
                每页
                <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }} style={{ margin: '0 4px' }}>
                  {[20, 50, 100, 200].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <span className="muted" style={{ fontSize: 12 }}>第 {page}/{totalPages} 页</span>
              <button className="btn" onClick={() => changePage(page - 1)} disabled={page <= 1}>上一页</button>
              <button className="btn" onClick={() => changePage(page + 1)} disabled={page >= totalPages}>下一页</button>
            </div>

            {busy && <div className="muted">处理中…</div>}
            {msg && <div className="muted" style={{ marginBottom: 8 }}>{msg}</div>}

            {/* 数据表 */}
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th style={{ position: 'sticky', left: 0, background: '#fafbfc', zIndex: 1 }}>操作</th>
                    {data && data.columns.map((c) => (
                      <th key={c.name}>{c.name}{c.pk ? ' 🔑' : ''}<br /><span className="muted" style={{ fontWeight: 400, fontSize: 11 }}>{c.type}</span></th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data && data.rows.map((row, i) => {
                    const key = JSON.stringify(row._pk);
                    const editing = editingKey === key;
                    return (
                      <tr key={key}>
                        <td style={{ position: 'sticky', left: 0, background: editing ? '#fff' : undefined, zIndex: 1, whiteSpace: 'nowrap' }}>
                          {editing ? (
                            <>
                              <button className="btn primary" style={{ padding: '3px 8px', fontSize: 12 }} onClick={() => saveEdit(row)}>保存</button>{' '}
                              <button className="btn" style={{ padding: '3px 8px', fontSize: 12 }} onClick={cancelEdit}>取消</button>
                            </>
                          ) : (
                            <>
                              <button className="btn" style={{ padding: '3px 8px', fontSize: 12 }} onClick={() => startEdit(row)}>编辑</button>{' '}
                              <button className="btn" style={{ padding: '3px 8px', fontSize: 12, color: 'var(--up)' }} onClick={() => delRow(row)}>删除</button>
                            </>
                          )}
                        </td>
                        {data.columns.map((c) => {
                          const v = row[c.name];
                          if (editing) {
                            return (
                              <td key={c.name}>
                                {c.pk ? (
                                  <span className="muted">{v == null ? '' : String(v)}</span>
                                ) : (
                                  <input
                                    type={NUMERIC.test(c.type) ? 'number' : 'text'}
                                    step="any"
                                    value={editDraft[c.name] == null ? '' : editDraft[c.name]}
                                    onChange={(e) => setEditDraft((d) => ({ ...d, [c.name]: e.target.value }))}
                                    style={{ width: 120 }}
                                  />
                                )}
                              </td>
                            );
                          }
                          return (
                            <td key={c.name} style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {v == null || v === '' ? <span className="muted">—</span> : String(v)}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                  {(!data || !data.rows.length) && (
                    <tr><td colSpan={(data ? data.columns.length : 0) + 1} className="muted" style={{ textAlign: 'center', padding: 24 }}>（无数据）</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* 新增行弹窗 */}
      {showAdd && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }} onClick={() => setShowAdd(false)}>
          <div className="panel" style={{ width: 520, maxWidth: '92vw', maxHeight: '88vh', overflow: 'auto', margin: 0 }} onClick={(e) => e.stopPropagation()}>
            <h3>新增行 → {activeTable}{scope === 'stock' ? ` · ${code}` : ''}</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {data && data.columns.map((c) => (
                <div key={c.name} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ width: 140, fontSize: 13 }}>{c.name}{c.pk ? ' 🔑' : ''} <span className="muted" style={{ fontSize: 11 }}>{c.type}</span></span>
                  <input
                    type={NUMERIC.test(c.type) ? 'number' : 'text'}
                    step="any"
                    value={addDraft[c.name] == null ? '' : addDraft[c.name]}
                    placeholder={c.pk && /AUTOINCREMENT/i.test('') ? '(自动)' : (c.pk ? '(主键必填)' : '')}
                    onChange={(e) => setAddDraft((d) => ({ ...d, [c.name]: e.target.value }))}
                    style={{ flex: 1, minWidth: 0 }}
                  />
                </div>
              ))}
            </div>
            <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
              <button className="btn primary" onClick={saveAdd} disabled={busy}>保存</button>
              <button className="btn" onClick={() => setShowAdd(false)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
