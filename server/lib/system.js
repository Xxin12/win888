'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// 标记: 避免重复触发重启
let restarting = false;

function logPath() {
  // server/lib -> 项目根/data/server.log
  return path.join(__dirname, '..', '..', 'data', 'server.log');
}

/**
 * 重启当前服务进程(自重启):
 * 以 detached 方式拉起一个与当前完全一致的 Node 进程(同 argv / cwd / env),
 * 然后退出当前进程, 由新进程接管端口。
 * .stdout/stderr 重定向到 data/server.log, 便于脱离终端后观察。
 * 返回 true 表示已成功发起重启(新进程已 spawn)。
 */
function restartSelf() {
  if (restarting) return false;
  restarting = true;
  try {
    let out;
    try {
      fs.mkdirSync(path.dirname(logPath()), { recursive: true });
      out = fs.openSync(logPath(), 'a');
    } catch (_) {
      out = 'ignore';
    }
    const child = spawn(process.execPath, process.argv.slice(1), {
      cwd: process.cwd(),
      detached: true,
      stdio: ['ignore', out, out],
      // 标记为新进程: index.js 据此先等待父进程释放端口再 listen, 避免 EADDRINUSE
      env: { ...process.env, RESTART_CHILD: '1' },
    });
    child.unref();
    // 略微延迟, 让 HTTP 响应先 flush, 并等旧进程释放端口
    setTimeout(() => {
      try { process.exit(0); } catch (_) {}
    }, 700);
    return true;
  } catch (e) {
    restarting = false;
    return false;
  }
}

function isRestarting() {
  return restarting;
}

module.exports = { restartSelf, isRestarting };
