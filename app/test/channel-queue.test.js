'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { QueueManager, normalizeUrl, parseUrls, buildArgs } = require('../lib/core');

const videoId = index => `test${String(index).padStart(7, '0')}`;
const videoUrl = index => `https://www.youtube.com/watch?v=${videoId(index)}`;
const entry = index => ({ url: videoUrl(index), title: `Video ${index}` });
const mediaBytes = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');

async function waitUntil(predicate, message) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message || 'Timed out waiting for queue');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function fixture(t, { initialState } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ember-channel-queue-test-'));
  const managers = [];
  const children = [];
  const outputDir = path.join(directory, 'downloads');
  const statePath = path.join(directory, 'queue.json');
  if (initialState) await fs.writeFile(statePath, JSON.stringify(initialState({ directory, outputDir })), 'utf8');
  const binaries = { ytDlp: process.execPath, ffmpeg: process.execPath, jsRuntime: process.execPath };
  function spawnFn(executable, args, options) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 900000 + children.length;
    child.exitCode = null;
    child.kill = () => true;
    children.push({ child, executable, args, options });
    return child;
  }
  async function terminateFn(child) {
    child.exitCode = 1;
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 1, 'SIGTERM');
  }
  async function createManager() {
    const manager = new QueueManager({ statePath, defaultOutputDir: outputDir, binaries, spawnFn, terminateFn });
    managers.push(manager);
    await manager.init();
    assert.equal(manager.engine.ready, true);
    return manager;
  }
  t.after(async () => {
    for (const manager of managers) await manager.shutdown();
    // Remove only the unique directory created by this fixture, never user data.
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    assert.ok(relative.startsWith('ember-channel-queue-test-') && !relative.includes(path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, outputDir, statePath, binaries, children, createManager, manager: await createManager() };
}

async function completeDownload(f, manager, job, bytes = mediaBytes, code = 0, metadata = {}) {
  await waitUntil(() => f.children.some(item => item.args.at(-1) === job.url), 'Downloader was not spawned');
  const spawned = f.children.findLast(item => item.args.at(-1) === job.url);
  const outputPath = path.join(job.outputDir, `${videoId(Number(job.title.match(/\d+/)?.[0] || '0'))}-${job.quality}.mp4`);
  await fs.mkdir(job.outputDir, { recursive: true });
  await fs.writeFile(outputPath, bytes);
  spawned.child.stdout.write(`__META__${JSON.stringify({ title: job.title, id: videoId(0), ...metadata })}\n`);
  spawned.child.stdout.end(`__FILE__${JSON.stringify(outputPath)}\n`);
  spawned.child.stderr.end();
  spawned.child.exitCode = code;
  spawned.child.emit('close', code, null);
  await waitUntil(() => !manager._active.has(job.id), 'Completion validation did not settle');
  return { outputPath, spawned };
}

test('imports more than 1,000 videos without truncation and persists every batch', async t => {
  const f = await fixture(t);
  for (let first = 0; first < 1250; first += 100) {
    const values = Array.from({ length: Math.min(100, 1250 - first) }, (_, offset) => entry(first + offset));
    assert.deepEqual(f.manager.addChannelBatch(values, { quality: '720', outputDir: f.outputDir }, 'UC-test-channel'),
      { added: values.length, duplicates: 0 });
  }
  assert.equal(f.manager.jobs.length, 1250);
  assert.equal(new Set(f.manager.jobs.map(job => job.url)).size, 1250);
  assert.ok(f.manager.jobs.every(job => job.status === 'paused' && job.quality === '720' && job.channelId === 'UC-test-channel'));
  assert.equal(f.children.length, 0);
  const assertCompact = state => {
    assert.ok(state.jobs.length <= 50, 'control operations must not clone the entire channel queue');
    assert.equal(state.queue.total, 1250);
  };
  assertCompact(f.manager.snapshot());
  assertCompact(f.manager.updateSettings({ concurrency: 1 }));
  assertCompact(f.manager.retry(f.manager.jobs[0].id));
  assertCompact(await f.manager.cancel(f.manager.jobs[0].id));
  assertCompact(f.manager.retry(f.manager.jobs[0].id));
  assertCompact(f.manager.start());
  assertCompact(await f.manager.pause());
  assert.ok(f.manager.jobs.every(job => job.status === 'paused'));
  await f.manager.shutdown();
  const saved = JSON.parse(await fs.readFile(f.statePath, 'utf8'));
  assert.equal(saved.jobs.length, 1250);
  const restarted = await f.createManager();
  assert.equal(restarted.jobs.length, 1250);
  assert.equal(restarted.paused, true);
  assert.equal(restarted.jobs.at(-1).url, videoUrl(1249));
});

test('rejects an invalid channel batch atomically and prevents normalized duplicates', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.manager.addChannelBatch([entry(1), entry(1), { url: `https://youtu.be/${videoId(1)}`, title: 'duplicate' }], {}, 'channel'),
    { added: 1, duplicates: 2 });
  assert.deepEqual(f.manager.addChannelBatch([entry(1), entry(2)], {}, 'channel'), { added: 1, duplicates: 1 });
  for (const invalid of [
    { url: 'https://www.youtube.com/@someone' },
    { url: 'https://evil.example/watch?v=test0000003' },
    { url: 'https://www.youtube.com/watch?v=test0000003 --exec=bad' },
    { url: 'https://user:password@www.youtube.com/watch?v=test0000003' },
    { url: 'https://www.bilibili.com/video/BV1xx411c7mD' },
    null,
  ]) {
    assert.throws(() => f.manager.addChannelBatch([entry(3), invalid], {}, 'channel'));
    assert.equal(f.manager.jobs.length, 2, 'a later invalid item must not partially import an earlier valid one');
  }
  assert.throws(() => f.manager.addChannelBatch(Array.from({ length: 101 }, (_, i) => entry(i + 10)), {}, 'channel'), /100/);
  assert.throws(() => f.manager.addChannelBatch([entry(3)], { quality: '--exec=bad' }, 'channel'));
  assert.throws(() => f.manager.addChannelBatch([entry(3)], { outputDir: 'relative\\folder' }, 'channel'));
  assert.equal(f.manager.jobs.length, 2);
  f.manager.remove(f.manager.jobs[0].id);
  assert.deepEqual(f.manager.addChannelBatch([entry(1)], {}, 'channel'), { added: 1, duplicates: 0 });
  const release = f.manager.acquireEngineUpdate();
  assert.throws(() => f.manager.addChannelBatch([entry(4)], {}, 'channel'), { code: 'ENGINE_BUSY' });
  release();
});

test('server pagination reports global counts, clamps pages, filters and returns detached views', async t => {
  const f = await fixture(t);
  f.manager.addChannelBatch(Array.from({ length: 100 }, (_, i) => entry(i)), {}, 'channel');
  f.manager.addChannelBatch(Array.from({ length: 37 }, (_, i) => entry(i + 100)), {}, 'channel');
  for (const [index, job] of f.manager.jobs.entries()) {
    job.status = index < 61 ? 'completed' : index < 64 ? 'failed' : index < 66 ? 'downloading' : index < 67 ? 'processing' : index < 69 ? 'cancelled' : index < 73 ? 'queued' : 'paused';
  }
  const snapshot = f.manager.snapshot({ page: 2, filter: 'all' });
  assert.equal(snapshot.jobs.length, 50);
  assert.equal(snapshot.jobs[0].url, videoUrl(50));
  assert.deepEqual(snapshot.queue, {
    total: 137, filteredTotal: 137, page: 2, pages: 3, pageSize: 50,
    counts: { completed: 61, active: 3, waiting: 68, failed: 3 }, hasFinished: true, hasQueued: true, filter: 'all',
  });
  snapshot.jobs[0].title = 'modified copy';
  assert.notEqual(f.manager.jobs[50].title, 'modified copy');
  const completed = f.manager.snapshot({ page: 999, filter: 'completed' });
  assert.equal(completed.queue.page, 2);
  assert.equal(completed.jobs.length, 11);
  assert.ok(completed.jobs.every(job => job.status === 'completed'));
  assert.equal(f.manager.snapshot({ page: -1, filter: 'failed' }).queue.page, 1);
  assert.equal(f.manager.snapshot({ page: 1, filter: 'active' }).jobs.length, 3);
  assert.equal(f.manager.snapshot({ page: NaN, filter: 'unknown' }).queue.filter, 'all');
  assert.equal(f.manager.snapshot({ page: NaN, filter: 'unknown' }).queue.page, 1);
  f.manager.clearFinished();
  const empty = f.manager.snapshot({ page: 20, filter: 'completed' });
  assert.equal(empty.jobs.length, 0);
  assert.equal(empty.queue.pages, 1);
  assert.equal(empty.queue.page, 1);
  assert.equal(empty.queue.hasFinished, false);
});

test('real completion records history only after an existing media file and successful exit', async t => {
  const f = await fixture(t);
  f.manager.addChannelBatch([entry(1), entry(2), entry(3)], { quality: '720' }, 'channel');
  f.manager.start();
  const [success, nonmedia, failed] = f.manager.jobs;
  const { spawned } = await completeDownload(f, f.manager, success, mediaBytes, 101);
  assert.equal(success.status, 'completed');
  assert.equal(success.progress, 100);
  assert.equal(await f.manager.wasDownloaded(success.url, success), true);
  assert.equal(spawned.options.shell, false);
  assert.deepEqual(spawned.args.slice(-2), ['--', success.url]);
  await completeDownload(f, f.manager, nonmedia, Buffer.from('<!doctype html><html>Access denied</html>'), 0);
  assert.equal(nonmedia.status, 'failed');
  assert.match(nonmedia.error, /非媒体内容/);
  assert.equal(nonmedia.outputPath, '');
  assert.equal(await f.manager.wasDownloaded(nonmedia.url, nonmedia), false);
  await completeDownload(f, f.manager, failed, mediaBytes, 1);
  assert.equal(failed.status, 'failed');
  assert.equal(await f.manager.wasDownloaded(failed.url, failed), false);
  assert.equal(f.manager.history.size, 1);
});

test('a zero exit without an output file cannot create completed history', async t => {
  const f = await fixture(t);
  f.manager.addChannelBatch([entry(1)], {}, 'channel');
  f.manager.start();
  await waitUntil(() => f.children.length === 1);
  f.children[0].child.exitCode = 0;
  f.children[0].child.stdout.end();
  f.children[0].child.stderr.end();
  f.children[0].child.emit('close', 0, null);
  await waitUntil(() => f.manager.jobs[0].status === 'failed');
  assert.equal(f.manager.history.size, 0);
});

test('completion history survives removing jobs, clearing and restarting, but respects file, quality and directory', async t => {
  const f = await fixture(t);
  f.manager.addChannelBatch([entry(1), entry(2)], { quality: '720' }, 'channel');
  f.manager.start();
  const [removed, cleared] = f.manager.jobs;
  const first = await completeDownload(f, f.manager, removed);
  await completeDownload(f, f.manager, cleared);
  f.manager.remove(removed.id);
  f.manager.clearFinished();
  assert.equal(f.manager.jobs.length, 0);
  assert.equal(f.manager.history.size, 2);
  await f.manager.shutdown();
  const restarted = await f.createManager();
  assert.equal(restarted.jobs.length, 0);
  assert.equal(await restarted.wasDownloaded(removed.url, removed), true);
  assert.equal(await restarted.wasDownloaded(cleared.url, cleared), true);
  assert.equal(await restarted.wasDownloaded(removed.url, { ...removed, quality: 'best' }), false);
  assert.equal(await restarted.wasDownloaded(removed.url, { ...removed, outputDir: path.join(f.directory, 'other-downloads') }), false);
  if (process.platform === 'win32') {
    assert.equal(await restarted.wasDownloaded(removed.url, { ...removed, outputDir: removed.outputDir.toUpperCase() }), true);
  }
  await fs.unlink(first.outputPath);
  assert.equal(await restarted.wasDownloaded(removed.url, removed), false);
  assert.equal(await restarted.wasDownloaded(cleared.url, cleared), true);
  await fs.truncate(cleared.outputPath, 0);
  assert.equal(await restarted.wasDownloaded(cleared.url, cleared), false);
});

test('pause, cancel, retry and restart require an explicit start before downloading resumes', async t => {
  const f = await fixture(t);
  f.manager.addChannelBatch([entry(1), entry(2), entry(3)], {}, 'channel');
  const cancelled = f.manager.jobs[0];
  await f.manager.cancel(cancelled.id);
  assert.equal(cancelled.status, 'cancelled');
  f.manager.retry(cancelled.id);
  assert.equal(f.manager.paused, true);
  assert.equal(f.children.length, 0);
  f.manager.start();
  await waitUntil(() => f.children.length === 2);
  await f.manager.pause();
  assert.equal(f.manager.paused, true);
  assert.equal(f.manager._active.size, 0);
  assert.ok(f.manager.jobs.every(job => job.status === 'paused'));
  assert.equal(f.manager.history.size, 0);
  f.manager.retry(cancelled.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.children.length, 2);
  await f.manager.shutdown();
  const restarted = await f.createManager();
  assert.equal(restarted.paused, true);
  assert.ok(restarted.jobs.every(job => job.status === 'paused'));
  assert.equal(f.children.length, 2);
  restarted.start();
  await waitUntil(() => f.children.length === 4);
  assert.equal(restarted._active.size, 2);
});

test('starting selected videos leaves unrelated paused and queued jobs paused until the global start button is used', async t => {
  const f = await fixture(t);
  f.manager.addChannelBatch([entry(0), entry(1), entry(2)], {}, 'channel');
  f.manager.jobs[1].status = 'queued';
  assert.equal(f.manager.startSelected([entry(2)], {}), 1);
  await waitUntil(() => f.children.length === 1);
  assert.deepEqual(f.manager.jobs.map(job => job.status), ['paused', 'paused', 'downloading']);
  assert.equal(f.children[0].args.at(-1), videoUrl(2));
  assert.equal(f.manager.paused, false);
  f.manager.start();
  await waitUntil(() => f.children.length === 2);
  assert.equal(f.children[1].args.at(-1), videoUrl(0));
  assert.equal(f.manager.jobs[1].status, 'queued', 'global start still resumes all remaining tasks');
});

test('selected start validates atomically, respects quality and output directory, and never retries finished states', async t => {
  const f = await fixture(t);
  f.manager.addChannelBatch([entry(0), entry(1), entry(2)], {}, 'channel');
  const before = f.manager.jobs.map(job => job.status);
  for (const values of [[], null, [entry(0), { url: 'https://evil.example' }], [entry(0), null]]) {
    assert.throws(() => f.manager.startSelected(values, {}));
    assert.deepEqual(f.manager.jobs.map(job => job.status), before);
    assert.equal(f.manager.paused, true);
  }
  assert.throws(() => f.manager.startSelected([entry(0)], { quality: 'invalid' }));
  assert.equal(f.manager.startSelected([entry(0)], { quality: 'audio' }), 0);
  assert.equal(f.manager.startSelected([entry(0)], { outputDir: path.join(f.directory, 'other') }), 0);
  for (const [index, status] of ['failed', 'cancelled', 'completed'].entries()) f.manager.jobs[index].status = status;
  assert.equal(f.manager.startSelected([entry(0), entry(1), entry(2)], {}), 0);
  assert.deepEqual(f.manager.jobs.map(job => job.status), ['failed', 'cancelled', 'completed']);
  assert.equal(f.manager.paused, true);
  assert.equal(f.children.length, 0);
});

test('selected start preserves already running downloads and their queued work', async t => {
  const f = await fixture(t);
  f.manager.updateSettings({ concurrency: 1 });
  f.manager.addChannelBatch([entry(0), entry(1)], {}, 'channel');
  f.manager.start();
  await waitUntil(() => f.children.length === 1);
  const existingChild = f.children[0].child;
  f.manager.addChannelBatch([entry(2)], {}, 'channel');
  f.manager.jobs[2].status = 'paused';
  assert.equal(f.manager.startSelected([entry(2), entry(2)], {}), 1, 'duplicate selections count one task');
  assert.deepEqual(f.manager.jobs.map(job => job.status), ['downloading', 'queued', 'queued']);
  assert.equal(f.children.length, 1);
  assert.equal(existingChild.exitCode, null);
  await completeDownload(f, f.manager, f.manager.jobs[0]);
  await waitUntil(() => f.children.length === 2);
  assert.equal(f.children[1].args.at(-1), videoUrl(1), 'previously queued work continues in its existing order');
  assert.equal(f.manager.jobs[2].status, 'queued');
});

test('change notifications stay compact and rapid batches share a persistence timer', async t => {
  const f = await fixture(t);
  const events = [];
  f.manager.on('change', (...args) => events.push(args));
  f.manager.addChannelBatch([entry(1)], {}, 'channel');
  const firstTimer = f.manager._saveTimer;
  f.manager.addChannelBatch([entry(2)], {}, 'channel');
  f.manager.addChannelBatch([entry(3)], {}, 'channel');
  assert.ok(firstTimer);
  assert.equal(f.manager._saveTimer, firstTimer);
  assert.equal(events.length, 3);
  assert.ok(events.every(args => args.length === 0));
  await f.manager.shutdown();
  assert.equal(f.manager._saveTimer, null);
  assert.equal(JSON.parse(await fs.readFile(f.statePath, 'utf8')).jobs.length, 3);
});

test('single-video URL normalization and downloader argument isolation remain intact', () => {
  assert.deepEqual(normalizeUrl(`https://youtu.be/${videoId(1)}?t=30`), { url: videoUrl(1), platform: 'YouTube' });
  assert.equal(normalizeUrl(`https://www.youtube.com/shorts/${videoId(1)}`).url, videoUrl(1));
  assert.equal(normalizeUrl(`https://www.youtube.com/live/${videoId(1)}`).url, videoUrl(1));
  assert.equal(normalizeUrl('https://www.bilibili.com/video/BV1xx411c7mD?p=2').url, 'https://www.bilibili.com/video/BV1xx411c7mD?p=2');
  assert.equal(normalizeUrl('https://www.twitch.tv/videos/123456').url, 'https://www.twitch.tv/videos/123456');
  assert.throws(() => normalizeUrl('https://www.youtube.com/@channel'));
  const parsed = parseUrls(`${videoUrl(1)}\nhttps://youtu.be/${videoId(1)}\nhttps://bad.example/video`);
  assert.equal(parsed.added.length, 1);
  assert.equal(parsed.duplicates.length, 1);
  assert.equal(parsed.errors.length, 1);
  const job = { url: videoUrl(1), quality: '720', outputDir: path.join(os.tmpdir(), 'output folder') };
  const binaries = { ffmpeg: process.execPath, jsRuntime: process.execPath };
  const args = buildArgs(job, binaries);
  for (const flag of ['--ignore-config', '--no-cookies', '--no-cookies-from-browser', '--no-playlist', '--continue']) assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf('--playlist-items') + 1], '1');
  assert.equal(args[args.indexOf('--max-downloads') + 1], '1');
  assert.equal(args[args.indexOf('--match-filters') + 1], '!is_live');
  assert.equal(args[args.indexOf('--paths') + 1], job.outputDir);
  assert.match(args[args.indexOf('--format') + 1], /height<=720/);
  assert.deepEqual(args.slice(-2), ['--', job.url]);
  const audio = buildArgs({ ...job, quality: 'audio' }, binaries);
  assert.ok(audio.includes('--extract-audio'));
  assert.equal(audio[audio.indexOf('--audio-format') + 1], 'mp3');
});

test('new video and audio filenames use actual upload or release dates with an explicit unknown fallback', () => {
  const binaries = { ffmpeg: process.execPath, jsRuntime: process.execPath };
  const prefix = '%(upload_date>%Y-%m-%d,release_date>%Y-%m-%d|日期未知)s ';
  for (const quality of ['best', '1080', '720', '480', 'audio']) {
    const job = { url: videoUrl(1), quality, outputDir: os.tmpdir(), namingVersion: 2, uploadDate: '' };
    const args = buildArgs(job, binaries);
    assert.equal(args[args.indexOf('--output') + 1], `${prefix}%(title).100B [%(id)s]-${quality}.%(ext)s`);
    const metadataPrint = args.find(arg => arg.startsWith('before_dl:__META__'));
    assert.ok(metadataPrint.includes('"upload_date":%(upload_date)j'));
    assert.ok(metadataPrint.includes('"release_date":%(release_date)j'));
    assert.ok(args.includes('--continue'));
    assert.deepEqual(args.slice(-2), ['--', job.url]);
  }
  const unversioned = buildArgs({ url: videoUrl(1), quality: 'best', outputDir: os.tmpdir() }, binaries);
  assert.ok(unversioned[unversioned.indexOf('--output') + 1].startsWith(prefix), 'direct new-job arguments default to dated naming');
});

test('single videos and channel batches save naming version 2 and retain it after restart', async t => {
  const f = await fixture(t);
  f.manager.add(videoUrl(1), { quality: 'audio' });
  f.manager.addChannelBatch([{ ...entry(2), uploadDate: '20261001', upload_date: '20261001' }], { quality: '720' }, 'channel');
  assert.deepEqual(f.manager.jobs.map(job => job.namingVersion), [2, 2]);
  assert.ok(f.manager.jobs.every(job => job.uploadDate === ''), 'scan-provided dates must not become authoritative download metadata');
  await f.manager.shutdown();
  const saved = JSON.parse(await fs.readFile(f.statePath, 'utf8'));
  assert.deepEqual(saved.jobs.map(job => job.namingVersion), [2, 2]);
  const restarted = await f.createManager();
  assert.deepEqual(restarted.jobs.map(job => job.namingVersion), [2, 2]);
  assert.ok(restarted.jobs.every(job => job.status === 'paused'));
});

test('download metadata accepts real calendar dates, prefers upload date and never invents approximate dates', async t => {
  const f = await fixture(t);
  f.manager.addChannelBatch([entry(1)], {}, 'channel');
  f.manager.start();
  await waitUntil(() => f.children.length === 1);
  const job = f.manager.jobs[0];
  const child = f.children[0].child;
  const cases = [
    [{ upload_date: '20261007', release_date: '20260101' }, '20261007'],
    [{ upload_date: null, release_date: '20260503' }, '20260503'],
    [{ upload_date: '20260230', release_date: '20260228' }, '20260228'],
    [{ upload_date: '20240229' }, '20240229'],
    [{ upload_date: '20230229' }, ''],
    [{ upload_date: '20261301' }, ''],
    [{ upload_date: '20261000' }, ''],
    [{ upload_date: 20261007 }, ''],
    [{ upload_date: '2026-10-07' }, ''],
    [{ timestamp: 1791321600, approximate_date: '20261007', upload_date: null, release_date: null }, ''],
    [{}, ''],
  ];
  for (const [metadata, expected] of cases) {
    child.stdout.write(`__META__${JSON.stringify({ title: 'Video 1', ...metadata })}\n`);
    assert.equal(job.uploadDate, expected, JSON.stringify(metadata));
  }
  await completeDownload(f, f.manager, job, mediaBytes, 0, { upload_date: '20240229' });
  assert.equal(job.uploadDate, '20240229');
  await f.manager.shutdown();
  const restarted = await f.createManager();
  assert.equal(restarted.jobs[0].uploadDate, '20240229');
  assert.equal(restarted.jobs[0].status, 'completed');
});

test('legacy persisted jobs retain original names and partial files when resumed and saved again', async t => {
  const f = await fixture(t, { initialState: ({ outputDir }) => ({
    version: 1,
    settings: { quality: '720', outputDir, concurrency: 1 },
    jobs: [{ id: 'legacy-video-job', url: videoUrl(1), title: 'Legacy video', status: 'downloading', quality: '720', outputDir,
      progress: 40, outputPath: '', diagnostic: '', error: '', attempts: 1, createdAt: '2026-10-01T00:00:00.000Z' }],
  }) });
  const job = f.manager.jobs[0];
  assert.equal(job.namingVersion, 1);
  assert.equal(job.status, 'paused');
  const legacyTemplate = '%(title).100B [%(id)s]-720.%(ext)s';
  assert.equal(buildArgs(job, f.binaries)[buildArgs(job, f.binaries).indexOf('--output') + 1], legacyTemplate);
  await fs.mkdir(f.outputDir, { recursive: true });
  const partPath = path.join(f.outputDir, `Legacy video [${videoId(1)}]-720.mp4.part`);
  const partBytes = Buffer.from('prior-partial-download');
  await fs.writeFile(partPath, partBytes);
  f.manager.retry(job.id);
  assert.equal(job.namingVersion, 1);
  f.manager.start();
  await waitUntil(() => f.children.length === 1);
  const spawned = f.children[0];
  assert.equal(spawned.args[spawned.args.indexOf('--output') + 1], legacyTemplate);
  assert.equal(spawned.args[spawned.args.indexOf('--paths') + 1], f.outputDir);
  assert.ok(spawned.args.includes('--continue'));
  await f.manager.pause();
  assert.deepEqual(await fs.readFile(partPath), partBytes);
  await f.manager.shutdown();
  const saved = JSON.parse(await fs.readFile(f.statePath, 'utf8'));
  assert.equal(saved.jobs[0].namingVersion, 1);
  const restarted = await f.createManager();
  assert.equal(restarted.jobs[0].namingVersion, 1);
  assert.equal(restarted.jobs[0].status, 'paused');
  const args = buildArgs(restarted.jobs[0], f.binaries);
  assert.equal(args[args.indexOf('--output') + 1], legacyTemplate);
  assert.deepEqual(await fs.readFile(partPath), partBytes);
});
