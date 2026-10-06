'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ChannelScanner } = require('../lib/channels');
const { ChannelImporter } = require('../lib/channel-import');

const videoId = number => String(number).padStart(11, '0');
const CHANNEL = 'UCabcdefghijklmnopqrstuv';

async function fixture(t, { count = 125, legacy = false, status = 'ready' } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cinder-selection-test-'));
  const statePath = path.join(directory, 'channel.json');
  const scanId = randomUUID();
  const state = { status, scanId, url: 'https://www.youtube.com/@example', tabs: ['videos', 'shorts'], discovered: count, skipped: 0, channelTitle: 'Example', channelId: CHANNEL, error: '', warnings: [], activeTab: '', partial: false };
  if (legacy) delete state.scanId;
  const entries = Array.from({ length: count }, (_, index) => ({ id: videoId(index + 1), url: `https://www.youtube.com/watch?v=${videoId(index + 1)}`, title: `${index % 2 ? 'Cat' : 'Dog'} 测试 ${index + 1}`, channelId: CHANNEL, channelTitle: 'Example', tab: index % 2 ? 'shorts' : 'videos' }));
  await fs.writeFile(statePath, JSON.stringify({ version: 1, state, entries }));
  const scanner = new ChannelScanner({ statePath, binaries: { ytDlp: path.join(directory, 'yt-dlp.exe') }, spawnFn: () => { throw new Error('Tests must not spawn network processes'); } });
  await scanner.init();
  const added = [];
  const checks = [];
  const manager = {
    engine: { ready: true }, settings: { quality: 'best', concurrency: 1, outputDir: path.join(directory, 'downloads') }, updates: 0, starts: 0,
    _assertReady() {}, _assertEngineNotUpdating() {},
    updateSettings(settings) { this.updates++; this.settings = { ...settings }; },
    async wasDownloaded(url, settings) { checks.push({ url, settings }); return false; },
    addChannelBatch(batch) { added.push(...batch.map(entry => ({ ...entry }))); return { added: batch.length, duplicates: 0 }; },
    async _persist() {}, startSelected(entries) { this.starts++; return entries.length; }
  };
  const importer = new ChannelImporter({ manager, scanner });
  t.after(async () => { await importer.shutdown(); await scanner.shutdown(); await fs.rm(directory, { recursive: true, force: true }); });
  return { scanner, manager, importer, added, checks, entries, statePath, directory, scanId: scanner.snapshot().scanId };
}

test('channel list paginates at 50, clamps bounds, returns copies and searches title or video id', async t => {
  const { scanner, scanId } = await fixture(t);
  const first = scanner.list({ scanId });
  assert.deepEqual({ total: first.total, filtered: first.filteredTotal, page: first.page, pages: first.pages, pageSize: first.pageSize }, { total: 125, filtered: 125, page: 1, pages: 3, pageSize: 50 });
  assert.equal(first.entries.length, 50);
  assert.deepEqual(Object.keys(first.entries[0]).sort(), ['id', 'title', 'url', 'tab'].sort());
  assert.equal(scanner.list({ page: 2 }).entries[0].id, videoId(51));
  assert.equal(scanner.list({ page: 999 }).page, 3);
  assert.equal(scanner.list({ page: 999 }).entries.length, 25);
  assert.equal(scanner.list({ page: -3 }).page, 1);
  first.entries[0].title = 'altered';
  assert.notEqual(scanner.entries[0].title, 'altered');
  const cats = scanner.list({ query: ' cAT ', page: 2 });
  assert.equal(cats.total, 125);
  assert.equal(cats.filteredTotal, 62);
  assert.equal(cats.pages, 2);
  assert.equal(cats.entries.length, 12);
  assert.equal(scanner.list({ query: videoId(91) }).entries[0].id, videoId(91));
  assert.equal(scanner.list({ query: '不存在', page: 9 }).page, 1);
  assert.equal(scanner.list({ query: '不存在' }).pages, 1);
  assert.equal(scanner.list({ query: '不存在' }).entries.length, 0);
  assert.throws(() => scanner.list({ scanId: randomUUID() }), { code: 'STALE_SCAN' });
  assert.throws(() => scanner.list({ page: 2.5 }), /页码/);
  assert.throws(() => scanner.list({ query: 'x'.repeat(501) }), /500/);
});

test('new scan gets a new UUID and rejects old list and download selections', async t => {
  const { scanner, scanId, importer, manager } = await fixture(t);
  const next = scanner.start({ url: scanner.snapshot().url, tabs: ['videos'] });
  assert.notEqual(next.scanId, scanId);
  assert.match(next.scanId, /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/);
  await scanner.cancel();
  assert.throws(() => scanner.list({ scanId }), { code: 'STALE_SCAN' });
  assert.throws(() => importer.start({}, { scanId, all: true }));
  assert.equal(manager.updates, 0);
  const third = scanner.start({ url: scanner.snapshot().url, tabs: ['videos'] });
  assert.notEqual(third.scanId, next.scanId);
  await scanner.cancel();
});

test('restored scan IDs remain stable and legacy records receive and persist an ID', async t => {
  const { scanner, scanId, statePath } = await fixture(t, { legacy: true, status: 'scanning' });
  assert.match(scanId, /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/);
  assert.equal(scanner.snapshot().status, 'interrupted');
  const persisted = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(persisted.state.scanId, scanId);
  const restored = new ChannelScanner({ statePath });
  await restored.init();
  assert.equal(restored.snapshot().scanId, scanId);
  assert.equal(restored.list({ scanId }).total, 125);
  await restored.shutdown();
});

test('missing, empty, unknown, stale, contradictory or oversized selections never mutate settings or import', async t => {
  const { importer, manager, scanId, added } = await fixture(t);
  const invalid = [
    undefined, null, [], {}, { scanId }, { scanId, ids: [] }, { scanId, ids: 'all' },
    { scanId: randomUUID(), all: true }, { scanId, ids: [videoId(999)] }, { scanId, ids: ['https://evil.example/video'] },
    { scanId, ids: [videoId(1)], all: true }, { scanId, all: false }, { scanId, all: 'true' },
    { scanId, ids: [videoId(1)], excludedIds: [] }, { scanId, all: true, excludedIds: [videoId(999)] },
    { scanId, all: true, excludedIds: [null] }, { scanId, ids: [videoId(1)], urls: ['https://evil.example'] },
    { scanId, ids: Array(100001).fill(videoId(1)) }, { scanId, all: true, excludedIds: Array(100001).fill(videoId(1)) }
  ];
  for (const selection of invalid) assert.throws(() => importer.start({ quality: 'audio' }, selection));
  assert.equal(manager.updates, 0);
  assert.equal(manager.starts, 0);
  assert.equal(manager.settings.quality, 'best');
  assert.equal(importer.busy, false);
  assert.equal(added.length, 0);
});

test('explicit subset excludes every unchecked item, deduplicates and preserves scan order across pages', async t => {
  const { importer, scanId, added, checks, manager } = await fixture(t);
  const result = await importer.start({ quality: 'audio' }, { scanId, ids: [videoId(125), videoId(51), videoId(2), videoId(51)] });
  assert.deepEqual(added.map(entry => entry.id), [2, 51, 125].map(videoId));
  assert.equal(checks.length, 3);
  assert(checks.every(check => check.settings.quality === 'audio'));
  assert.equal(result.selected, 3);
  assert.equal(result.added, 3);
  assert.equal(result.remaining, 0);
  assert.equal(result.started, true);
  assert.equal(manager.starts, 1);
});

test('explicit select all supports validated exclusions and rejects excluding the full set', async t => {
  const { importer, scanId, added, manager } = await fixture(t, { count: 4 });
  assert.throws(() => importer.start({}, { scanId, all: true, excludedIds: [1, 2, 3, 4].map(videoId) }), /请选择/);
  assert.equal(manager.updates, 0);
  const result = await importer.start({}, { scanId, all: true, excludedIds: [videoId(2), videoId(4), videoId(2)] });
  assert.deepEqual(added.map(entry => entry.id), [1, 3].map(videoId));
  assert.equal(result.selected, 2);
  added.length = 0;
  const all = await importer.start({}, { scanId, all: true });
  assert.equal(all.selected, 4);
  assert.deepEqual(added.map(entry => entry.id), [1, 2, 3, 4].map(videoId));
});

test('selected entry membership and fields are frozen before async history checks', async t => {
  const { importer, scanner, manager, scanId, added, entries } = await fixture(t, { count: 4 });
  let release;
  let first = true;
  manager.wasDownloaded = async () => {
    if (!first) return false;
    first = false;
    return new Promise(resolve => { release = resolve; });
  };
  const pending = importer.start({}, { scanId, ids: [videoId(1), videoId(4)] });
  assert.equal(importer.busy, true);
  assert.throws(() => importer.start({}, { scanId, all: true }), /正在加入/);
  scanner.entries[0].title = 'mutated';
  scanner.entries.splice(0, scanner.entries.length, { ...entries[1] });
  release(false);
  const result = await pending;
  assert.equal(result.selected, 2);
  assert.equal(result.added, 2);
  assert.deepEqual(added.map(entry => entry.id), [1, 4].map(videoId));
  assert.equal(added[0].title, 'Dog 测试 1');
});
