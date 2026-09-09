'use strict';
/**
 * 实时行情服务: 定时拉取订阅代码的报价, 通过WebSocket推送前端。
 * 断线/失败自动退避重试; 保留最近快照供REST兜底。
 */
const { WebSocketServer } = require('ws');
const tencent = require('./providers/tencent');

class RealtimeService {
  constructor(server, { interval = 3000 } = {}) {
    this.wss = new WebSocketServer({ server, path: '/ws/quotes' });
    this.interval = interval;
    this.subs = new Set(); // 订阅的代码
    this.snapshot = new Map(); // code -> quote
    this.timer = null;
    this.backoff = 0;

    this.wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'hello', snapshot: [...this.snapshot.values()] }));
      ws.on('message', (buf) => {
        try {
          const msg = JSON.parse(buf.toString());
          if (msg.type === 'subscribe' && Array.isArray(msg.codes)) {
            msg.codes.forEach((c) => this.subs.add(tencent.normCode(c)));
            this.tick(); // 立即拉一次
          }
        } catch (_) {}
      });
    });
  }

  setDefaultSubs(codes) {
    codes.forEach((c) => this.subs.add(tencent.normCode(c)));
  }

  start() {
    this.stop();
    this.tick();
    this.timer = setInterval(() => this.tick(), this.interval);
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async tick() {
    if (this.subs.size === 0) return;
    const codes = [...this.subs];
    try {
      const quotes = await tencent.getQuotes(codes);
      const now = new Date();
      const stamp = now.toTimeString().slice(0, 8);
      quotes.forEach((q) => { q._recv = stamp; this.snapshot.set(q.code, q); });
      this.broadcast({ type: 'quotes', ts: stamp, live: true, data: quotes });
      this.backoff = 0;
    } catch (e) {
      this.backoff = Math.min(this.backoff + 1, 5);
      this.broadcast({ type: 'error', msg: '行情拉取失败(降级到缓存): ' + e.message, live: false, data: [...this.snapshot.values()] });
    }
  }

  broadcast(obj) {
    const s = JSON.stringify(obj);
    this.wss.clients.forEach((c) => { if (c.readyState === 1) c.send(s); });
  }

  getSnapshot(codes) {
    if (!codes) return [...this.snapshot.values()];
    return codes.map((c) => this.snapshot.get(tencent.normCode(c))).filter(Boolean);
  }
}

module.exports = { RealtimeService };
