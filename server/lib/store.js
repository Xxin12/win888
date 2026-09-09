'use strict';
const fs = require('fs');
const path = require('path');
const DATA = path.join(__dirname, '..', '..', 'data');

function readJson(name, def) {
  const f = path.join(DATA, name);
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return def; }
}
function writeJson(name, obj) {
  fs.writeFileSync(path.join(DATA, name), JSON.stringify(obj, null, 2), 'utf8');
}
module.exports = { readJson, writeJson, DATA };
