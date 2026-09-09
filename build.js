'use strict';
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');
const outdir = path.join(__dirname, 'server', 'public');
fs.mkdirSync(outdir, { recursive: true });

// 拷贝 index.html, 并注入构建版本号(解决 SPA 跨轮不刷新导致跑旧 bundle 的问题)
const ver = Date.now();
{
  let html = fs.readFileSync(path.join(__dirname, 'client', 'index.html'), 'utf8');
  html = html.replace('./app.js', `./app.js?v=${ver}`);
  html = html.replace('</body>', `<script>window.__APP_VERSION__="${ver}";</script>\n</body>`);
  fs.writeFileSync(path.join(outdir, 'index.html'), html, 'utf8');
}
fs.writeFileSync(path.join(outdir, '.version'), String(ver), 'utf8');

const opts = {
  entryPoints: [path.join(__dirname, 'client', 'src', 'main.jsx')],
  bundle: true,
  outfile: path.join(outdir, 'app.js'),
  format: 'iife',
  target: ['es2019'],
  loader: { '.js': 'jsx', '.jsx': 'jsx' },
  jsx: 'automatic',
  minify: !watch,
  charset: 'utf8',
  sourcemap: watch,
  logLevel: 'info',
};

(async () => {
  if (watch) {
    const ctx = await esbuild.context(opts);
    await ctx.watch();
    console.log('[esbuild] watching...');
  } else {
    await esbuild.build(opts);
    console.log('[esbuild] build done ->', opts.outfile);
  }
})();
