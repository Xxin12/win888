'use strict';
/** 绩效统计: 输入每日 net 收益数组的交易记录 [{date,net,...}] */
function summarize(name, trades) {
  const n = trades.length;
  if (n === 0) return { strategy: name, days: 0, gross: 0, fee: 0, net: 0, wins: 0, win_rate: 0, avg_win: 0, avg_loss: 0, mdd: 0, sharpe: 0, best: 0, worst: 0, net_per_100d: 0, equity: [] };
  const nets = trades.map((t) => t.net);
  const gross = trades.reduce((s, t) => s + (t.gross || 0), 0);
  const fee = trades.reduce((s, t) => s + (t.fee || 0), 0);
  const net = nets.reduce((a, b) => a + b, 0);
  const wins = nets.filter((v) => v > 0).length;
  const winArr = nets.filter((v) => v > 0);
  const lossArr = nets.filter((v) => v <= 0);
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

  // 最大回撤(累计净值峰谷差)
  let cum = 0, peak = 0, mdd = 0;
  const equity = [];
  trades.forEach((t) => {
    cum += t.net;
    equity.push({ date: t.date, equity: +cum.toFixed(2) });
    peak = Math.max(peak, cum);
    mdd = Math.min(mdd, cum - peak);
  });

  // 夏普(按日收益, 年化 sqrt(244))
  const rMean = mean(nets);
  const variance = nets.reduce((s, v) => s + (v - rMean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? +((rMean / std) * Math.sqrt(244)).toFixed(3) : 0;

  return {
    strategy: name,
    days: n,
    gross: +gross.toFixed(2),
    fee: +fee.toFixed(2),
    net: +net.toFixed(2),
    wins,
    win_rate: +((wins / n) * 100).toFixed(2),
    avg_win: +mean(winArr).toFixed(2),
    avg_loss: +mean(lossArr).toFixed(2),
    mdd: +mdd.toFixed(2),
    sharpe,
    best: +Math.max(...nets).toFixed(2),
    worst: +Math.min(...nets).toFixed(2),
    net_per_100d: +((net / n) * 100).toFixed(2),
    equity,
  };
}

module.exports = { summarize };
