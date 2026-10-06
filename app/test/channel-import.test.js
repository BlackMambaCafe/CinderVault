'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { QueueManager } = require('../lib/core');
const { ChannelImporter, channelDirectory } = require('../lib/channel-import');

const channelId = 'UCabcdefghijklmnopqrstuv';
const channelUrl = 'https://www.youtube.com/@test-channel';
const videoUrl = index => `https://www.youtube.com/watch?v=test${String(index).padStart(7, '0')}`;
const entry = index => ({ id: `test${String(index).padStart(7, '0')}`, url: videoUrl(index), title: `Video ${index}` });
const entries = count => Array.from({ length: count }, (_, index) => entry(index));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, values = entries(1)) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ember-channel-import-test-'));
  const statePath = path.join(directory, 'queue.json');
  const outputDir = path.join(directory, 'downloads');
  const manager = new QueueManager({
    statePath, defaultOutputDir: outputDir,
    binaries: { ytDlp: process.execPath, ffmpeg: process.execPath },
    spawnFn: () => { throw new Error('Importer tests must not launch a network downloader'); },
  });
  await manager.init();
  const managers = [manager];
  const scan = { scanId: 'fixture-scan-token', url: channelUrl, channelId, channelTitle: 'Original title', status: 'ready' };
  const scanner = { entries: values, busy: false, unsafeStop: false, snapshot: () => ({ ...scan }) };
  const events = [];
  const importer = new ChannelImporter({ manager, scanner, onChange: () => events.push(importer.message) });
  const startCalls = [];
  // Core start/download semantics are exercised in channel-queue.test.js. Capture
  // the importer hand-off without starting real downloads here.
  manager.startSelected = (selected, settings) => {
    const keys = new Set(selected.map(item => manager._historyKey({ ...item, ...settings })));
    const ready = manager.jobs.filter(job => keys.has(manager._historyKey(job)) && ['queued', 'paused'].includes(job.status));
    if (ready.length) { startCalls.push(ready.map(job => job.url)); for (const job of ready) job.status = 'downloading'; }
    return ready.length;
  };
  t.after(async () => {
    await importer.shutdown();
    for (const instance of managers) await instance.shutdown();
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    assert.ok(relative.startsWith('ember-channel-import-test-') && !relative.includes(path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, statePath, outputDir, manager, managers, scan, scanner, importer, events, startCalls };
}

async function waitUntil(predicate, message) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message || 'Timed out waiting for simulated download');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('channel destination remains stable across title changes and never uses title as a path', () => {
  const base = path.join(os.tmpdir(), 'downloads');
  const scan = { channelId, url: channelUrl, channelTitle: 'A title' };
  assert.equal(channelDirectory(base, scan), path.join(base, `YouTube-${channelId}`));
  assert.equal(channelDirectory(base, { ...scan, channelTitle: '../../another drive' }), channelDirectory(base, scan));
  const fallback = channelDirectory(base, { url: channelUrl, channelId: '../../outside' });
  assert.match(path.basename(fallback), /^YouTube-[a-f0-9]{16}$/);
  assert.equal(path.dirname(fallback), base);
  assert.equal(fallback, channelDirectory(base, { url: channelUrl, channelTitle: 'Renamed' }));
  assert.notEqual(fallback, channelDirectory(base, { url: 'https://www.youtube.com/@different' }));
});

test('imports ordered batches, skips existing files and queued duplicates, persists before starting', async t => {
  const values = [...entries(205), entry(5)];
  const f = await fixture(t, values);
  const destination = channelDirectory(f.outputDir, f.scan);
  await fs.mkdir(destination, { recursive: true });
  const outputPath = path.join(destination, 'already-downloaded.mp4');
  await fs.writeFile(outputPath, Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex'));
  f.manager._remember({ url: videoUrl(1), quality: '720', outputDir: destination, outputPath });
  f.manager.addChannelBatch([entry(2)], { quality: '720', outputDir: destination }, channelId);
  const calls = [];
  const addBatch = f.manager.addChannelBatch.bind(f.manager);
  f.manager.addChannelBatch = (...args) => { calls.push({ action: 'batch', length: args[0].length }); return addBatch(...args); };
  const persist = f.manager._persist.bind(f.manager);
  f.manager._persist = async () => { await persist(); calls.push({ action: 'persisted' }); };
  const startSelected = f.manager.startSelected.bind(f.manager);
  f.manager.startSelected = (...args) => { const started = startSelected(...args); if (started) calls.push({ action: 'start' }); return started; };
  const result = await f.importer.start({ outputDir: f.outputDir, quality: '720', concurrency: 1 }, { scanId: f.scan.scanId, all: true });
  assert.deepEqual(result, { added: 203, duplicates: 2, historySkipped: 1, errors: [], remaining: 0, outputDir: destination, started: true, selected: 206 });
  assert.deepEqual(calls.filter(call => call.action === 'batch').map(call => call.length), [99, 100, 6]);
  assert.deepEqual(calls.slice(-2).map(call => call.action), ['persisted', 'start']);
  assert.equal(f.manager.jobs.length, 204);
  const expectedOrder = [videoUrl(2), ...entries(205).filter(item => ![videoUrl(1), videoUrl(2)].includes(item.url)).map(item => item.url)];
  assert.deepEqual(f.manager.jobs.map(job => job.url), expectedOrder);
  assert.ok(f.manager.jobs.every(job => job.outputDir === destination && job.quality === '720'));
  assert.equal(f.manager.settings.outputDir, f.outputDir, 'channel directory must not replace the chosen base folder');
  assert.equal(f.manager.settings.concurrency, 1);
  assert.equal(f.importer.busy, false);
  assert.ok(f.events.length >= 5);
  const saved = JSON.parse(await fs.readFile(f.statePath, 'utf8'));
  assert.equal(saved.jobs.length, 204);
  assert.equal(saved.history.length, 1);
  const duplicateRun = await f.importer.start({ outputDir: f.outputDir, quality: '720' }, { scanId: f.scan.scanId, all: true });
  assert.equal(duplicateRun.added, 0);
  assert.equal(duplicateRun.historySkipped, 1);
  assert.equal(duplicateRun.duplicates, 205);
  assert.equal(duplicateRun.started, false);
  assert.equal(calls.filter(call => call.action === 'start').length, 1, 'duplicate-only import must not resume the queue');
});

test('partial capacity failure preserves imported batches and reports exact unprocessed count', async t => {
  const values = entries(205);
  const f = await fixture(t, values);
  const addBatch = f.manager.addChannelBatch.bind(f.manager);
  let batches = 0;
  f.manager.addChannelBatch = (...args) => {
    batches++;
    if (batches === 2) throw new Error('队列已达到容量上限');
    return addBatch(...args);
  };
  const result = await f.importer.start({ quality: 'best' }, { scanId: f.scan.scanId, all: true });
  assert.equal(result.added, 100);
  assert.equal(result.remaining, 105);
  assert.equal(result.started, false);
  assert.deepEqual(result.errors, [{ error: '队列已达到容量上限' }]);
  assert.deepEqual(f.manager.jobs.map(job => job.url), values.slice(0, 100).map(item => item.url));
  assert.equal(f.startCalls.length, 0);
  assert.equal(f.scanner.entries, values);
  assert.equal(f.importer.busy, false);
  assert.equal(JSON.parse(await fs.readFile(f.statePath, 'utf8')).jobs.length, 100, 'partial imports must be saved before failure is returned');
  f.manager.addChannelBatch = addBatch;
  const retry = await f.importer.start({ quality: 'best' }, { scanId: f.scan.scanId, all: true });
  assert.equal(retry.added, 105);
  assert.equal(retry.duplicates, 100);
  assert.equal(retry.remaining, 0);
  assert.equal(retry.started, true);
  assert.equal(f.manager.jobs.length, 205);
  assert.equal(f.startCalls.length, 1);
});

test('a second import click is rejected while busy and pause suppresses automatic start', async t => {
  const f = await fixture(t, entries(3));
  const gate = deferred();
  t.after(() => gate.resolve());
  f.manager.wasDownloaded = async () => { await gate.promise; return false; };
  const pending = f.importer.start({ quality: '720' }, { scanId: f.scan.scanId, all: true });
  assert.equal(f.importer.busy, true);
  assert.throws(() => f.importer.start({ quality: '720' }, { scanId: f.scan.scanId, all: true }), /正在加入/);
  f.importer.suppressAutostart();
  gate.resolve();
  const result = await pending;
  assert.equal(result.added, 3);
  assert.equal(result.started, false);
  assert.equal(f.startCalls.length, 0);
  assert.equal(f.manager.paused, true);
  assert.equal(f.importer.busy, false);
  assert.equal(f.manager.jobs.length, 3);
  assert.ok(f.manager.jobs.every(job => job.status === 'paused'));
});

test('shutdown settles an import and cannot automatically resume the queue', async t => {
  const f = await fixture(t, entries(205));
  const gate = deferred();
  t.after(() => gate.resolve());
  f.manager.wasDownloaded = async () => { await gate.promise; return false; };
  const pending = f.importer.start({ quality: 'best' }, { scanId: f.scan.scanId, all: true });
  const closing = f.importer.shutdown();
  assert.equal(f.importer.closed, true);
  gate.resolve();
  const result = await pending;
  await closing;
  assert.equal(result.added + result.remaining, 205);
  assert.equal(result.started, false);
  assert.ok(result.remaining >= 105, 'shutdown must stop after the in-flight batch at the latest');
  assert.equal(f.startCalls.length, 0);
  assert.equal(f.importer.busy, false);
  assert.equal(f.manager.paused, true);
  assert.throws(() => f.importer.start({}, { scanId: f.scan.scanId, all: true }), /正在退出/);
  const saved = JSON.parse(await fs.readFile(f.statePath, 'utf8'));
  assert.equal(saved.jobs.length, result.added);
});

test('persistence failure reports the error and leaves imported jobs paused', async t => {
  const f = await fixture(t);
  const persist = f.manager._persist.bind(f.manager);
  f.manager._persist = async () => { f.manager.engine.persistenceError = '队列保存失败：test disk full'; };
  const result = await f.importer.start({}, { scanId: f.scan.scanId, all: true });
  f.manager._persist = persist;
  assert.equal(result.added, 1);
  assert.equal(result.remaining, 0);
  assert.equal(result.started, false);
  assert.deepEqual(result.errors, [{ error: '队列保存失败：test disk full' }]);
  assert.equal(f.startCalls.length, 0);
  assert.equal(f.manager.paused, true);
  assert.equal(f.importer.busy, false);
});

test('unsafe or incomplete scans, missing engine and invalid settings cannot begin import', async t => {
  const f = await fixture(t);
  f.scan.status = 'idle';
  assert.throws(() => f.importer.start({}, { scanId: f.scan.scanId, all: true }), /请先扫描频道/);
  f.scan.status = 'scanning';
  assert.throws(() => f.importer.start({}, { scanId: f.scan.scanId, all: true }), /请先完成或停止/);
  f.scan.status = 'ready';
  f.scanner.busy = true;
  assert.throws(() => f.importer.start({}, { scanId: f.scan.scanId, all: true }), /请先完成或停止/);
  f.scanner.busy = false;
  f.scanner.unsafeStop = true;
  assert.throws(() => f.importer.start({}, { scanId: f.scan.scanId, all: true }), /请先完成或停止/);
  f.scanner.unsafeStop = false;
  f.manager.engine.ready = false;
  assert.throws(() => f.importer.start({}, { scanId: f.scan.scanId, all: true }), /尚未就绪/);
  f.manager.engine.ready = true;
  const release = f.manager.acquireEngineUpdate();
  assert.throws(() => f.importer.start({}, { scanId: f.scan.scanId, all: true }), { code: 'ENGINE_BUSY' });
  release();
  assert.throws(() => f.importer.start({ outputDir: 'relative' }, { scanId: f.scan.scanId, all: true }), /绝对路径/);
  assert.equal(f.manager.jobs.length, 0);
  assert.equal(f.importer.busy, false);
  assert.equal(f.startCalls.length, 0);
});

test('partial scan results remain importable after error, cancellation or interruption', async t => {
  const f = await fixture(t);
  for (const [index, status] of ['error', 'cancelled', 'interrupted'].entries()) {
    f.scan.status = status;
    f.scanner.entries = [entry(index)];
    const result = await f.importer.start({ quality: 'best' }, { scanId: f.scan.scanId, all: true });
    assert.equal(result.added, 1);
    assert.equal(result.errors.length, 0);
    assert.equal(result.remaining, 0);
    assert.equal(result.started, true);
  }
  assert.equal(f.manager.jobs.length, 3);
  assert.equal(f.startCalls.length, 3);
});

test('selecting an existing paused video resumes only that video and a failed selection does not retry itself', async t => {
  const f = await fixture(t, entries(3));
  const destination = channelDirectory(f.outputDir, f.scan);
  f.manager.addChannelBatch([entry(0), entry(1)], { quality: '720', outputDir: destination }, channelId);
  f.manager.add(videoUrl(2), { quality: '720' });
  assert.deepEqual(f.manager.jobs.map(job => job.status), ['paused', 'paused', 'queued']);
  const children = [];
  f.manager.startSelected = QueueManager.prototype.startSelected.bind(f.manager);
  f.manager.spawnFn = (_executable, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 920000 + children.length;
    child.kill = () => true;
    children.push({ child, args });
    return child;
  };
  f.manager.terminateFn = async child => { child.exitCode = 1; child.emit('close', 1, null); };
  const result = await f.importer.start({ quality: '720', outputDir: f.outputDir }, { scanId: f.scan.scanId, ids: [entry(1).id] });
  assert.equal(result.added, 0);
  assert.equal(result.duplicates, 1);
  assert.equal(result.started, true, 'an existing paused selection must resume even when no new job is added');
  await waitUntil(() => children.length === 1);
  assert.equal(children[0].args.at(-1), videoUrl(1));
  assert.deepEqual(f.manager.jobs.map(job => job.status), ['paused', 'downloading', 'paused']);
  children[0].child.stdout.end();
  children[0].child.stderr.end();
  children[0].child.exitCode = 1;
  children[0].child.emit('close', 1, null);
  await waitUntil(() => f.manager.jobs[1].status === 'failed');
  const failed = await f.importer.start({ quality: '720', outputDir: f.outputDir }, { scanId: f.scan.scanId, ids: [entry(1).id] });
  assert.equal(failed.added, 0);
  assert.equal(failed.duplicates, 1);
  assert.equal(failed.started, false);
  assert.equal(children.length, 1);
  assert.deepEqual(f.manager.jobs.map(job => job.status), ['paused', 'failed', 'paused']);
});

test('retained completed tasks skip valid files, restore deleted files, and preserve quality and directory variants across restart', async t => {
  const f = await fixture(t);
  let launches = 0;
  f.manager.startSelected = QueueManager.prototype.startSelected.bind(f.manager);
  f.manager.spawnFn = (_executable, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 910000 + launches;
    child.kill = () => true;
    const destination = args[args.indexOf('--paths') + 1];
    const outputPath = path.join(destination, `simulated-media-${++launches}.mp4`);
    setImmediate(async () => {
      try {
        await fs.writeFile(outputPath, Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex'));
        child.stdout.end(`__FILE__${JSON.stringify(outputPath)}\n`);
        child.stderr.end();
        child.exitCode = 0;
        child.emit('close', 0, null);
      } catch (error) { child.emit('error', error); }
    });
    return child;
  };
  f.manager.terminateFn = async child => { child.exitCode = 1; child.emit('close', 1, null); };

  const first = await f.importer.start({ quality: '720', outputDir: f.outputDir }, { scanId: f.scan.scanId, all: true });
  assert.equal(first.started, true);
  await waitUntil(() => f.manager.jobs[0]?.status === 'completed', 'Initial import did not complete');
  const original = f.manager.jobs[0];
  const originalId = original.id;
  const originalOutput = original.outputPath;
  assert.equal(f.manager.history.size, 1);
  const same = await f.importer.start({ quality: '720', outputDir: f.outputDir }, { scanId: f.scan.scanId, all: true });
  assert.equal(same.historySkipped, 1);
  assert.equal(same.added, 0);
  assert.equal(same.started, false);
  assert.equal(launches, 1);
  assert.equal(f.manager.jobs.length, 1, 'completed record stays in the visible queue');

  await fs.unlink(originalOutput);
  const restored = await f.importer.start({ quality: '720', outputDir: f.outputDir }, { scanId: f.scan.scanId, all: true });
  assert.equal(restored.added, 1);
  assert.equal(restored.historySkipped, 0);
  assert.equal(restored.duplicates, 0);
  assert.equal(restored.started, true);
  await waitUntil(() => original.status === 'completed', 'Deleted file was not downloaded again');
  assert.equal(f.manager.jobs.length, 1, 'the obsolete completed record is reused rather than duplicated');
  assert.equal(original.id, originalId);
  assert.notEqual(original.outputPath, originalOutput);
  assert.equal(launches, 2);
  assert.equal(await f.manager.wasDownloaded(original.url, original), true);

  const betterQuality = await f.importer.start({ quality: 'best', outputDir: f.outputDir }, { scanId: f.scan.scanId, all: true });
  assert.equal(betterQuality.added, 1);
  assert.equal(betterQuality.started, true);
  await waitUntil(() => f.manager.jobs.length === 2 && f.manager.jobs.every(job => job.status === 'completed'));
  assert.deepEqual(f.manager.jobs.map(job => job.quality), ['720', 'best']);

  const otherBase = path.join(f.directory, 'different-output');
  const otherFolder = await f.importer.start({ quality: '720', outputDir: otherBase }, { scanId: f.scan.scanId, all: true });
  assert.equal(otherFolder.added, 1);
  assert.equal(otherFolder.started, true);
  await waitUntil(() => f.manager.jobs.length === 3 && f.manager.jobs.every(job => job.status === 'completed'));
  assert.equal(f.manager.jobs[2].outputDir, channelDirectory(otherBase, f.scan));
  assert.equal(new Set(f.manager.jobs.map(job => job.url)).size, 1);
  assert.equal(new Set(f.manager.jobs.map(job => job.id)).size, 3);
  assert.equal(launches, 4);
  assert.equal(f.manager.history.size, 3);
  const beforeRestart = f.manager.jobs.map(job => ({ id: job.id, url: job.url, quality: job.quality, outputDir: job.outputDir, outputPath: job.outputPath }));
  await f.manager.shutdown();
  const restarted = new QueueManager({
    statePath: f.statePath, defaultOutputDir: f.outputDir,
    binaries: { ytDlp: process.execPath, ffmpeg: process.execPath },
    spawnFn: () => { throw new Error('Restart must not automatically download'); },
  });
  f.managers.push(restarted);
  await restarted.init();
  assert.equal(restarted.paused, true);
  assert.equal(restarted.jobs.length, 3);
  assert.deepEqual(restarted.jobs.map(job => ({ id: job.id, url: job.url, quality: job.quality, outputDir: job.outputDir, outputPath: job.outputPath })), beforeRestart);
  assert.equal(restarted.history.size, 3);
  for (const job of restarted.jobs) assert.equal(await restarted.wasDownloaded(job.url, job), true);
});
