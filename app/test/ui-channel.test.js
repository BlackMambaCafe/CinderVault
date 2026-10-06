'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const uiDir = path.join(__dirname, '..', 'ui');
const markup = fs.readFileSync(path.join(uiDir, 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(uiDir, 'renderer.js'), 'utf8');

// Minimal DOM boundary: exercise the actual renderer and its public IPC bridge.
class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = {};
    this.style = {}; this.value = ''; this.textContent = ''; this.hidden = false; this.disabled = false;
    this.checked = false; this.open = false;
    const classes = new Set();
    this.classList = { toggle: (name, on) => on ? classes.add(name) : classes.delete(name), remove: name => classes.delete(name), contains: name => classes.has(name) };
  }
  append(...children) { for (const child of children) this.children.push(...(child.tagName === '#fragment' ? child.children : [child])); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key]; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
  async fire(type, extra = {}) { if (type === 'click' && this.disabled) return; for (const callback of this.listeners[type] || []) await callback({ target: this, preventDefault() {}, ...extra }); }
  closest() { return null; }
  querySelectorAll() { return []; }
  get firstElementChild() { return this.children[0]; }
  get options() { return this.children; }
  focus() {} remove() {} load() {} pause() {} play() { return Promise.resolve(); }
  close() { this.open = false; } showModal() { this.open = true; }
}

function snapshot(changes = {}) {
  return {
    settings: { outputDir: 'D:\\Videos', quality: '720', concurrency: 2 },
    jobs: [], paused: false, engine: { ready: true }, updater: { canUpdate: true }, backgrounds: [], appVersion: '1.0.5',
    channel: { status: 'idle', discovered: 0, skipped: 0, warnings: [] },
    queue: { total: 0, filteredTotal: 0, page: 1, pages: 1, pageSize: 50, counts: { completed: 0, active: 0, waiting: 0, failed: 0 }, hasFinished: false, hasQueued: false },
    ...changes,
    channel: { scanId: changes.channel && changes.channel.status !== 'idle' ? 'scan-one' : '', status: 'idle', discovered: 0, skipped: 0, warnings: [], ...(changes.channel || {}) }
  };
}

async function harness(initial = snapshot(), overrides = {}, preview = false) {
  const elements = new Map();
  for (const match of markup.matchAll(/<([a-z][\w-]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)) {
    const node = new Element(match[1]); const attrs = match[0];
    node.checked = /\bchecked\b/.test(attrs); node.disabled = /\bdisabled\b/.test(attrs); node.hidden = /\bhidden\b/.test(attrs);
    node.value = attrs.match(/\bvalue="([^"]*)"/)?.[1] || ''; elements.set(match[2], node);
  }
  const tabs = ['all', 'active', 'completed', 'failed'].map(filter => { const node = new Element('button'); node.dataset.filter = filter; return node; });
  let current = structuredClone(initial); let stateListener;
  const calls = [];
  const api = {
    async getState(view) { calls.push(['getState', view]); current.queue.page = view.page; return structuredClone(current); },
    onState(callback) { stateListener = callback; return () => {}; },
    async updateSettings(settings) { calls.push(['updateSettings', settings]); current.settings = settings; },
    async scanChannel(input) { calls.push(['scanChannel', input]); current.channel = { ...current.channel, ...input, scanId: `scan-${calls.length}`, status: 'scanning', discovered: 0 }; },
    async cancelChannelScan() { calls.push(['cancelChannelScan']); current.channel.status = 'cancelled'; },
    async getChannelEntries(view) {
      calls.push(['getChannelEntries', view]);
      const total = current.channel.discovered;
      const all = Array.from({ length: total }, (_, index) => ({ id: String(index).padStart(11, '0'), title: `Video ${index}`, url: `https://www.youtube.com/watch?v=${String(index).padStart(11, '0')}`, tab: 'videos' }));
      const entries = view.query ? all.filter(entry => entry.title.toLowerCase().includes(view.query.toLowerCase()) || entry.id.includes(view.query)) : all;
      const pages = Math.max(1, Math.ceil(entries.length / 50)); const page = Math.min(pages, view.page);
      return { scanId: current.channel.scanId, total, filteredTotal: entries.length, page, pages, pageSize: 50, entries: entries.slice((page - 1) * 50, page * 50) };
    },
    async downloadChannel(settings, selection) { calls.push(['downloadChannel', settings, selection]); return { added: 1, duplicates: 2, historySkipped: 3, errors: [] }; },
    async checkUpdates() {}, async installUpdate() { calls.push(['installUpdate']); },
    async start() { calls.push(['start']); }, async pause() { calls.push(['pause']); },
    async clearFinished() {}, ...overrides
  };
  const document = {
    getElementById(id) { assert.ok(elements.has(id), `Missing HTML element #${id}`); return elements.get(id); },
    createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag), createDocumentFragment: () => new Element('#fragment'),
    querySelectorAll(selector) { return selector === '[data-filter]' ? tabs : []; },
    body: new Element('body'), addEventListener() {}, visibilityState: 'visible', activeElement: null
  };
  const context = { document, window: { downloader: preview ? undefined : api, matchMedia: () => ({ matches: true, addEventListener() {} }), addEventListener() {}, scrollTo() {} }, localStorage: { getItem() { return null; }, setItem() {} }, URL, structuredClone, setTimeout() {}, console };
  vm.runInNewContext(renderer, context, { filename: 'renderer.js' });
  await new Promise(resolve => setImmediate(resolve));
  return { get: id => elements.get(id), calls, tabs, emit(next) { current = structuredClone(next); stateListener?.(structuredClone(current)); }, current: () => current };
}

test('channel scan sends all selected types, protects scanning and can cancel', async () => {
  const h = await harness();
  h.get('channelUrl').value = 'https://www.youtube.com/@example';
  await h.get('channelUrl').fire('input');
  assert.equal(h.get('scanChannel').disabled, false);
  await h.get('scanChannel').fire('click');
  const call = h.calls.find(call => call[0] === 'scanChannel');
  assert.deepEqual(JSON.parse(JSON.stringify(call[1])), { url: 'https://www.youtube.com/@example', tabs: ['videos', 'shorts', 'streams'] });
  assert.equal(h.get('downloadChannel').disabled, true);
  assert.equal(h.get('installEngineUpdate').disabled, true);
  assert.equal(h.get('channelUrl').disabled, true);
  assert.equal(h.get('cancelChannelScan').hidden, false);
  await h.get('cancelChannelScan').fire('click');
  assert.equal(h.get('downloadChannel').disabled, true, 'empty cancelled scan cannot import');
  assert.match(h.get('channelIncomplete').textContent, /不完整/);
});

test('partial results are explicit and changing the input requires a fresh scan', async () => {
  const h = await harness(snapshot({ channel: { status: 'error', discovered: 4, skipped: 1, url: 'https://www.youtube.com/@example', tabs: ['videos'], channelTitle: 'Example', warnings: [], error: 'Connection interrupted' } }));
  assert.equal(h.get('downloadChannel').disabled, true, 'no video is selected by default');
  await h.get('channelSelectPage').fire('click');
  assert.equal(h.get('downloadChannel').disabled, false);
  assert.equal(h.get('downloadChannelLabel').textContent, '下载所选 4 个');
  assert.equal(h.get('channelIncomplete').hidden, false);
  assert.match(h.get('channelError').textContent, /interrupted/);
  h.get('channelUrl').value = 'https://www.youtube.com/@different';
  await h.get('channelUrl').fire('input');
  assert.equal(h.get('downloadChannel').disabled, true);
  assert.match(h.get('channelStatus').textContent, /重新扫描/);
});

test('channel import captures shared settings and reports queue and history skips', async () => {
  const h = await harness(snapshot({ channel: { status: 'ready', discovered: 6, skipped: 0, warnings: [] } }));
  await h.get('channelSelectPage').fire('click');
  await h.get('downloadChannel').fire('click');
  const call = h.calls.find(call => call[0] === 'downloadChannel');
  assert.deepEqual(JSON.parse(JSON.stringify(call[1])), { outputDir: 'D:\\Videos', quality: '720', concurrency: 2 });
  assert.match(h.get('channelImportMessage').textContent, /已加入 1 个任务/);
  assert.match(h.get('channelImportMessage').textContent, /队列重复 2/);
  assert.match(h.get('channelImportMessage').textContent, /已下载跳过 3/);
});

test('global queue counts and controls survive a filtered page with no waiting jobs', async () => {
  const h = await harness(snapshot({ jobs: [{ id: 'done', status: 'completed', url: 'https://example.test/1', title: 'Saved' }], queue: { total: 2000, filteredTotal: 2000, page: 1, pages: 40, pageSize: 50, counts: { completed: 1700, active: 2, waiting: 298, failed: 0 }, hasFinished: true, hasQueued: true } }));
  assert.equal(h.get('queueCount').textContent, '2000');
  assert.equal(h.get('completedCount').textContent, '1700');
  assert.equal(h.get('startButton').disabled, false);
  assert.equal(h.get('pauseButton').disabled, false);
  assert.equal(h.get('installEngineUpdate').disabled, true);
  assert.equal(h.get('queueNext').disabled, false);
  await h.get('queueNext').fire('click');
  assert.equal(h.calls.at(-1)[1].page, 2);
  assert.match(h.get('queuePageInfo').textContent, /第 2 \/ 40 页/);
  await h.tabs.find(tab => tab.dataset.filter === 'failed').fire('click');
  assert.equal(h.calls.at(-1)[1].page, 1);
  assert.equal(h.calls.at(-1)[1].filter, 'failed');
  assert.equal(h.get('jobList').children.length, 1, 'server page is rendered without a second client filter');
});

test('engine update and preview mode cannot start channel work', async () => {
  const h = await harness(snapshot({ engine: { ready: true, updating: true }, channel: { status: 'ready', discovered: 3, warnings: [] } }));
  h.get('channelUrl').value = 'https://www.youtube.com/@example';
  await h.get('channelUrl').fire('input');
  assert.equal(h.get('scanChannel').disabled, true);
  assert.equal(h.get('downloadChannel').disabled, true);
  const p = await harness(snapshot(), {}, true);
  p.get('channelUrl').value = 'https://www.youtube.com/@example';
  await p.get('channelUrl').fire('input');
  assert.equal(p.get('scanChannel').disabled, true);
  assert.equal(p.get('downloadChannel').disabled, true);
  assert.match(p.get('channelStatus').textContent, /预览未连接/);
});

test('scanner finalization and an unconfirmed process stop keep imports and updates locked', async () => {
  const h = await harness(snapshot({ channel: { status: 'ready', discovered: 3, warnings: [], busy: true } }));
  assert.equal(h.get('downloadChannel').disabled, true);
  assert.equal(h.get('installEngineUpdate').disabled, true);
  assert.match(h.get('channelStatus').textContent, /保存扫描结果/);
  h.emit(snapshot({ channel: { status: 'error', discovered: 3, warnings: [], unsafeStop: true } }));
  assert.equal(h.get('downloadChannel').disabled, true);
  assert.equal(h.get('scanChannel').disabled, true);
  assert.equal(h.get('installEngineUpdate').disabled, true);
  assert.match(h.get('channelStatus').textContent, /确认扫描进程/);
});

test('an absent channel tab is informational; explicit partial results stay incomplete', async () => {
  const h = await harness(snapshot({ channel: { status: 'ready', discovered: 4, warnings: ['该频道没有直播回放分类，已跳过'], partial: false } }));
  assert.equal(h.get('downloadChannelLabel').textContent, '下载所选 0 个');
  assert.equal(h.get('channelIncomplete').hidden, true);
  assert.equal(h.get('channelWarnings').hidden, false);
  h.emit(snapshot({ channel: { status: 'ready', discovered: 4, warnings: ['平台返回了部分列表'], partial: true } }));
  assert.match(h.get('channelDownloadSummary').textContent, /扫描结果不完整/);
  assert.equal(h.get('channelIncomplete').hidden, false);
});

test('video titles are paged and manual selection survives navigation and search', async () => {
  const h = await harness(snapshot({ channel: { status: 'ready', discovered: 121 } }));
  const rows = () => h.get('channelEntryList').children;
  assert.equal(rows().length, 50);
  assert.equal(rows()[0].children[1].children[0].textContent, 'Video 0');
  assert.equal(rows()[0].children[0].checked, false);
  assert.equal(h.get('downloadChannel').disabled, true);
  const firstBox = rows()[0].children[0]; firstBox.checked = true; await firstBox.fire('change');
  await h.get('channelEntryNext').fire('click');
  assert.equal(rows().length, 50);
  assert.equal(rows()[0].children[1].children[0].textContent, 'Video 50');
  await h.get('channelSelectPage').fire('click');
  assert.equal(h.get('downloadChannelLabel').textContent, '下载所选 51 个');
  h.get('channelSearch').value = 'Video 120'; await h.get('channelSearchButton').fire('click');
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].children[0].checked, false);
  assert.equal(h.get('downloadChannelLabel').textContent, '下载所选 51 个');
  await h.get('downloadChannel').fire('click');
  const request = h.calls.find(call => call[0] === 'downloadChannel')[2];
  assert.equal(request.scanId, 'scan-one');
  assert.equal(request.ids.length, 51);
  assert.equal(request.ids.includes('00000000000'), true);
  assert.equal(request.ids.includes('00000000120'), false);
});

test('select all uses an explicit token and unchecking exclusions does not fetch the whole channel', async () => {
  const h = await harness(snapshot({ channel: { status: 'ready', discovered: 121 } }));
  const before = h.calls.filter(call => call[0] === 'getChannelEntries').length;
  await h.get('channelSelectAll').fire('click');
  assert.equal(h.get('downloadChannelLabel').textContent, '下载所选 121 个');
  assert.equal(h.calls.filter(call => call[0] === 'getChannelEntries').length, before);
  assert.equal(h.get('channelEntryList').children.length, 50);
  const box = h.get('channelEntryList').children[0].children[0]; box.checked = false; await box.fire('change');
  assert.equal(h.get('downloadChannelLabel').textContent, '下载所选 120 个');
  await h.get('downloadChannel').fire('click');
  const request = h.calls.find(call => call[0] === 'downloadChannel')[2];
  assert.deepEqual(JSON.parse(JSON.stringify(request)), { scanId: 'scan-one', all: true, excludedIds: ['00000000000'] });
  await h.get('channelClearSelection').fire('click');
  assert.equal(h.get('downloadChannel').disabled, true);
  assert.equal(h.get('downloadChannelLabel').textContent, '下载所选 0 个');
});

test('a new scan resets selection and late list responses cannot replace its results', async () => {
  let releaseOld;
  const h = await harness(snapshot({ channel: { status: 'ready', discovered: 2 } }), {
    async getChannelEntries(view) {
      if (view.query === 'slow') return new Promise(resolve => { releaseOld = resolve; });
      return { scanId: view.scanId, total: 2, filteredTotal: 1, page: 1, pages: 1, entries: [{ id: '00000000001', title: view.scanId, tab: 'videos' }] };
    }
  });
  await h.get('channelSelectAll').fire('click');
  h.get('channelSearch').value = 'slow'; const searching = h.get('channelSearchButton').fire('click');
  h.emit(snapshot({ channel: { scanId: 'scan-two', status: 'ready', discovered: 2 } }));
  await new Promise(resolve => setImmediate(resolve));
  releaseOld({ scanId: 'scan-one', total: 2, filteredTotal: 1, page: 1, pages: 1, entries: [{ id: '00000000002', title: 'STALE OLD RESULT', tab: 'videos' }] });
  await searching;
  assert.equal(h.get('downloadChannelLabel').textContent, '下载所选 0 个');
  assert.equal(h.get('downloadChannel').disabled, true);
  assert.equal(h.get('channelSearch').value, '');
  assert.equal(h.get('channelEntryList').children[0].children[1].children[0].textContent, 'scan-two');
});

test('both quality controls synchronize and the selected quality is sent with the selected IDs', async () => {
  const h = await harness(snapshot({ channel: { status: 'ready', discovered: 2 } }));
  assert.equal(h.get('channelQuality').value, '720');
  h.get('channelQuality').value = '1080'; await h.get('channelQuality').fire('change');
  assert.equal(h.get('quality').value, '1080');
  assert.match(h.get('channelDownloadSummary').textContent, /1080p 上限/);
  h.get('quality').value = 'audio'; await h.get('quality').fire('change');
  assert.equal(h.get('channelQuality').value, 'audio');
  await h.get('channelSelectPage').fire('click');
  await h.get('downloadChannel').fire('click');
  const request = h.calls.find(call => call[0] === 'downloadChannel');
  assert.equal(request[1].quality, 'audio');
  assert.equal(request[2].ids.length, 2);
  assert.match(h.get('channelDownloadSummary').textContent, /MP3 仅音频/);
});

test('an older settings broadcast cannot overwrite a quality choice awaiting persistence', async () => {
  let release;
  const h = await harness(snapshot({ channel: { status: 'ready', discovered: 2 } }), {
    async updateSettings() { await new Promise(resolve => { release = resolve; }); }
  });
  h.get('channelQuality').value = '1080'; const changing = h.get('channelQuality').fire('change');
  await new Promise(resolve => setImmediate(resolve));
  h.emit(snapshot({ settings: { outputDir: 'D:\\Videos', quality: '480', concurrency: 2 }, channel: { status: 'ready', discovered: 2 } }));
  assert.equal(h.get('quality').value, '1080');
  assert.equal(h.get('channelQuality').value, '1080');
  h.emit(snapshot({ settings: { outputDir: 'D:\\Videos', quality: '1080', concurrency: 2 }, channel: { status: 'ready', discovered: 2 } }));
  release(); await changing;
  assert.equal(h.get('quality').value, '1080');
  assert.equal(h.get('channelQuality').value, '1080');
});

test('resuming selected queued videos reports success when no new task was added', async () => {
  const h = await harness(snapshot({ channel: { status: 'ready', discovered: 1 } }), {
    async downloadChannel() { return { added: 0, duplicates: 1, historySkipped: 0, errors: [], started: true }; }
  });
  await h.get('channelSelectPage').fire('click');
  await h.get('downloadChannel').fire('click');
  const toast = h.get('toastRegion').children.at(-1);
  assert.equal(toast.children[1].textContent, '已继续下载所选视频');
  assert.match(h.get('channelImportMessage').textContent, /队列重复 1/);
});
