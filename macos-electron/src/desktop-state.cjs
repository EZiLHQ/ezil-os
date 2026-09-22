'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { atomic, readJSON } = require('./files.cjs');
function preferences(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(k => !['wallpaper', 'accent', 'previewPort', 'layout', 'browser'].includes(k))) throw Error('Invalid desktop preferences');
  const result = {};
  for (const [key, choices] of Object.entries({ wallpaper: ['charcoal', 'teal-dusk', 'deep-slate', 'aurora'], accent: ['teal', 'violet', 'amber', 'rose'] })) {
    if (value[key] !== undefined) { if (!choices.includes(value[key])) throw Error('Invalid appearance'); result[key] = value[key]; }
  }
  if (value.previewPort !== undefined) {
    if (!Number.isInteger(value.previewPort) || value.previewPort < 1024 || value.previewPort > 65535) throw Error('Invalid preview');
    result.previewPort = value.previewPort;
  }
  if (value.layout !== undefined) {
    if (!Array.isArray(value.layout) || value.layout.length > 4) throw Error('Invalid layout');
    const apps = new Set();
    result.layout = value.layout.map(item => {
      if (!item || Object.getPrototypeOf(item) !== Object.prototype || Object.keys(item).some(k => !['app', 'x', 'y', 'width', 'height', 'minimized'].includes(k)) || !['browser', 'code', 'preview', 'settings'].includes(item.app) || apps.has(item.app) || typeof item.minimized !== 'boolean') throw Error('Invalid window');
      apps.add(item.app);
      for (const key of ['x', 'y', 'width', 'height']) if (!Number.isFinite(item[key]) || Math.abs(item[key]) > 32768 || (['width', 'height'].includes(key) && item[key] < 1)) throw Error('Invalid window bounds');
      return { ...item };
    });
  }
  if (value.browser !== undefined) {
    const b = value.browser;
    if (!b || Object.getPrototypeOf(b) !== Object.prototype || Object.keys(b).some(k => !['tabs', 'activeIndex'].includes(k))
        || !Array.isArray(b.tabs) || b.tabs.length < 1 || b.tabs.length > 20 || !Number.isInteger(b.activeIndex) || b.activeIndex < 0 || b.activeIndex >= b.tabs.length) throw Error('Invalid browser preferences');
    const tabs = b.tabs.map(value => {
      if (typeof value !== 'string' || value.length > 4096) throw Error('Invalid browser tab');
      if (value === '') return value;
      const url = new URL(value);
      if (url.href !== value || url.username || url.password || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw Error('Invalid browser tab');
      return value;
    });
    result.browser = { tabs, activeIndex: b.activeIndex };
  }
  return result;
}
function readDesktop(workspace) {
  const file = path.join(workspace.dir, 'desktop.json');
  if (!fs.existsSync(file)) return {};
  try { return preferences(readJSON(file)); } catch { return {}; }
}
function writeDesktop(workspace, value) { atomic(path.join(workspace.dir, 'desktop.json'), JSON.stringify(preferences(value))); }
module.exports = { preferences, readDesktop, writeDesktop };
