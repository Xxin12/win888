'use strict';
// 企业微信通知模块
// 支持两种发送模式:
//   1) 群机器人 Webhook  (msgtype=markdown, 无需 access_token)
//   2) 自建应用消息      (corpid+corpsecret 换 access_token 后 /cgi-bin/message/send)
const { readJson, writeJson } = require('./store');
const gstore = require('./globalStore'); // 通知日志落库(global.db)
const crypto = require('crypto');

const DEFAULT = {
  enabled: false,                 // 总开关
  mode: 'webhook',                // 'webhook' | 'app'
  webhook: { key: '' },           // 群机器人 URL 中 key= 后的部分
  app: { corpid: '', corpsecret: '', agentid: '', touser: '@all' },
  notifyBottom: true,             // 指标底部信号是否通知
  notifyTop: true,                // 指标顶部信号是否通知
  notifyMinConfidence: 'low',      // 自动推送最低置信度: low|medium|high（默认 low=所有置信度都发, 不做数量限制）
};

// 发送日志: 记录每一次通知触发(含被配置挡住 / 实际发送结果), 落库 data/db/global.db.notify_log
function appendNotifyLog(entry) {
  try {
    gstore.appendNotifyLog(entry);
  } catch (_) { /* 日志失败不阻塞通知 */ }
}

function readConfig() {
  const stored = readJson('wecom-config.json', null) || {};
  // 浅合并默认, 保证字段完整
  return {
    ...DEFAULT,
    ...stored,
    webhook: { ...DEFAULT.webhook, ...(stored.webhook || {}) },
    app: { ...DEFAULT.app, ...(stored.app || {}) },
  };
}

function sanitize(o) {
  o = o || {};
  return {
    enabled: !!o.enabled,
    mode: o.mode === 'app' ? 'app' : 'webhook',
    webhook: { key: String((o.webhook && o.webhook.key) || '').trim() },
    app: {
      corpid: String((o.app && o.app.corpid) || '').trim(),
      corpsecret: String((o.app && o.app.corpsecret) || '').trim(),
      agentid: String((o.app && o.app.agentid) || '').trim(),
      touser: String((o.app && o.app.touser) || '@all').trim() || '@all',
    },
    notifyBottom: o.notifyBottom !== false,
    notifyTop: o.notifyTop !== false,
    notifyMinConfidence: ['low', 'medium', 'high'].includes(o.notifyMinConfidence) ? o.notifyMinConfidence : 'high',
  };
}

function saveConfig(o) {
  const cfg = sanitize(o);
  writeJson('wecom-config.json', cfg);
  return cfg;
}

// ---- 自建应用 access_token 缓存 (进程内) ----
let _tokenCache = { token: null, exp: 0 };
async function getAccessToken(app) {
  const now = Date.now();
  if (_tokenCache.token && _tokenCache.exp > now + 60000) return _tokenCache.token;
  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(app.corpid)}&corpsecret=${encodeURIComponent(app.corpsecret)}`;
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  if (j.errcode !== 0) throw new Error('获取access_token失败: ' + (j.errmsg || j.errcode));
  _tokenCache = { token: j.access_token, exp: now + (j.expires_in || 7200) * 1000 };
  return j.access_token;
}

function buildContent(type, code, name, time, price, avg, extra) {
  extra = extra || {};
  const isBottom = type === 'bottom';
  const emoji = isBottom ? '🔵' : '🔴';
  const title = isBottom ? '底部信号' : '顶部信号';
  const ts = time || new Date().toLocaleString('zh-CN', { hour12: false });
  const shortCode = String(code || '').replace(/^(sh|sz|bj)/, '');
  const src = isBottom ? '底部信号' : '顶部信号';
  const fmtN = (v) => { const n = Number(v); return Number.isFinite(n) ? n.toFixed(2) : '--'; };
  const confTxt = (c) => (c === 'high' ? '高' : c === 'medium' ? '中' : c === 'low' ? '低' : (c || '—'));
  const divTxt = (d) => (d === 'bullish' ? '底背离(看多)' : d === 'bearish' ? '顶背离(看空)' : '无');
  let s = `${emoji} 【${title}】${name || ''}(${shortCode})\n`;
  s += `实时价格：${fmtN(price)}\n`;
  s += `当日均价：${fmtN(avg)}\n`;
  if (extra.confidence) s += `置信度：${confTxt(extra.confidence)}\n`;
  if (extra.dev != null && Number.isFinite(Number(extra.dev))) s += `乖离：${fmtN(extra.dev)}%\n`;
  if (extra.divergence) s += `背离：${divTxt(extra.divergence)}\n`;
  if (extra.volRatio != null && Number.isFinite(Number(extra.volRatio))) s += `量比：${fmtN(extra.volRatio)}\n`;
  s += `时间：${ts}\n`;
  s += `来源：当日分时主图（${src}）\n`;
  s += `请结合分时与做T决策面板综合判断，注意风险。`;
  return s;
}

// 本地(北京时区)今日 YYYY-MM-DD（统一去重键用）
function localDateStr(d) {
  const x = d || new Date();
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

// 去掉 dataURL 前缀, 返回纯 base64
function stripDataUrl(s) {
  if (!s) return '';
  if (typeof s === 'string' && s.startsWith('data:')) {
    const i = s.indexOf(',');
    return i >= 0 ? s.slice(i + 1) : '';
  }
  return s;
}

// 群机器人 webhook 发送图片消息 (base64 + md5)
async function sendWebhookImage(url, dataUrl) {
  const b64 = stripDataUrl(dataUrl);
  if (!b64) return { ok: false, reason: 'empty-image' };
  let md5;
  try { md5 = crypto.createHash('md5').update(Buffer.from(b64, 'base64')).digest('hex'); }
  catch (e) { return { ok: false, reason: 'md5-fail', error: e.message }; }
  const body = { msgtype: 'image', image: { base64: b64, md5 } };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: j.errcode === 0, raw: j };
}

// 自建应用: 上传图片素材 -> media_id
async function uploadAppMedia(token, dataUrl) {
  const b64 = stripDataUrl(dataUrl);
  const buf = Buffer.from(b64, 'base64');
  const blob = new Blob([buf], { type: 'image/png' });
  const fd = new FormData();
  fd.append('media', blob, 'chart.png');
  const r = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=${encodeURIComponent(token)}&type=image`, {
    method: 'POST',
    body: fd,
  });
  const j = await r.json().catch(() => ({}));
  if (j.errcode !== 0) throw new Error('media上传失败: ' + (j.errmsg || j.errcode));
  return j.media_id;
}

// 通用文本通知(用于每日补齐等任务汇总)。webhook 模式发 markdown, app 模式发 text。
// opts.touser: app 模式下指定接收人(覆盖配置); webhook 模式忽略(群机器人固定群)。
async function sendText(content, { touser } = {}) {
  const cfg = readConfig();
  if (!cfg.enabled) return { ok: false, reason: 'disabled' };
  try {
    if (cfg.mode === 'webhook') {
      if (!cfg.webhook.key) return { ok: false, reason: 'no-webhook-key' };
      const url = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(cfg.webhook.key)}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
      });
      const j = await r.json().catch(() => ({}));
      return { ok: j.errcode === 0, mode: 'webhook', raw: j };
    }
    if (cfg.mode === 'app') {
      const app = cfg.app;
      if (!app.corpid || !app.corpsecret || !app.agentid) return { ok: false, reason: 'app-incomplete' };
      const token = await getAccessToken(app);
      const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          touser: touser || app.touser || '@all',
          msgtype: 'text',
          agentid: Number(app.agentid),
          text: { content },
        }),
      });
      const j = await r.json().catch(() => ({}));
      return { ok: j.errcode === 0, mode: 'app', raw: j };
    }
    return { ok: false, reason: 'unknown-mode' };
  } catch (e) {
    return { ok: false, reason: 'exception', error: e.message };
  }
}

// 发送通知。payload: { type:'bottom'|'top', code, name, price?, avg?, time?, images?:[dataURL] }
async function sendNotify(payload = {}) {
  const cfg = readConfig();
  const type = payload.type === 'top' ? 'top' : 'bottom';
  const code = payload.code, name = payload.name;
  // 统一去重键: code|本地日期|type|信号时间(与前端推送、服务端兜底扫描共用)
  const sigDate = localDateStr();
  const sigTime = payload.time || new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const sigKey = `${code}|${sigDate}|${type}|${sigTime}`;
  const log = (ok, reason, mode) => appendNotifyLog({
    time: new Date().toISOString(), code, name, type,
    ok: !!ok, reason: reason || null, mode: mode || null, sigKey,
  });

  if (!cfg.enabled) { log(false, 'disabled'); return { ok: false, reason: 'disabled' }; }
  if (type === 'bottom' && !cfg.notifyBottom) { log(false, 'bottom-off'); return { ok: false, reason: 'bottom-off' }; }
  if (type === 'top' && !cfg.notifyTop) { log(false, 'top-off'); return { ok: false, reason: 'top-off' }; }

  // 注意: 按需求已「完全去掉去重」——不再以 notify_log.sig_key 拦截任何发送(避免漏发)。
  // notify_log 仍照常写入, 仅作发送审计记录, 不再作为发送前的去重依据。

  const content = buildContent(type, payload.code, payload.name, payload.time, payload.price, payload.avg,
    { confidence: payload.confidence, dev: payload.dev, divergence: payload.divergence, volRatio: payload.volRatio });
  const images = Array.isArray(payload.images) ? payload.images.filter(Boolean) : [];

  try {
    if (cfg.mode === 'webhook') {
      if (!cfg.webhook.key) { log(false, 'no-webhook-key'); return { ok: false, reason: 'no-webhook-key' }; }
      const url = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(cfg.webhook.key)}`;
      // 1) 文字(markdown) 携带价格/均价
      const r1 = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
      });
      const j1 = await r1.json().catch(() => ({}));
      const results = [{ kind: 'text', ok: j1.errcode === 0, raw: j1 }];
      // 2) 逐张发送分时/K线截图
      for (let i = 0; i < images.length; i++) {
        const r = await sendWebhookImage(url, images[i]);
        results.push({ kind: 'image', ok: r.ok, raw: r.raw });
      }
      const ok = results.every((x) => x.ok);
      log(ok, ok ? null : 'partial', 'webhook');
      return { ok, mode: 'webhook', results };
    }
    if (cfg.mode === 'app') {
      const app = cfg.app;
      if (!app.corpid || !app.corpsecret || !app.agentid) { log(false, 'app-incomplete'); return { ok: false, reason: 'app-incomplete' }; }
      const token = await getAccessToken(app);
      const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`;
      // 1) 文字(text)
      const r1 = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          touser: app.touser || '@all',
          msgtype: 'text',
          agentid: Number(app.agentid),
          text: { content },
        }),
      });
      const j1 = await r1.json().catch(() => ({}));
      const results = [{ kind: 'text', ok: j1.errcode === 0, raw: j1 }];
      // 2) 逐张发送截图(需先上传素材拿 media_id)
      for (let i = 0; i < images.length; i++) {
        try {
          const mediaId = await uploadAppMedia(token, images[i]);
          const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              touser: app.touser || '@all',
              msgtype: 'image',
              agentid: Number(app.agentid),
              image: { media_id: mediaId },
            }),
          });
          const j = await r.json().catch(() => ({}));
          results.push({ kind: 'image', ok: j.errcode === 0, raw: j });
        } catch (e) {
          results.push({ kind: 'image', ok: false, error: e.message });
        }
      }
      const ok = results.every((x) => x.ok);
      log(ok, ok ? null : 'partial', 'app');
      return { ok, mode: 'app', results };
    }
    log(false, 'unknown-mode');
    return { ok: false, reason: 'unknown-mode' };
  } catch (e) {
    log(false, 'exception');
    return { ok: false, reason: 'exception', error: e.message };
  }
}

module.exports = { readConfig, saveConfig, sendNotify, sendText, buildContent };
