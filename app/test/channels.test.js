'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ChannelScanner, normalizeChannelUrl, buildScanArgs } = require('../lib/channels');

const CHANNEL = 'UCabcdefghijklmnopqrstuv';
const URL = 'https://www.youtube.com/@example';
const videoId = number => String(number).padStart(11, '0');
const line = (number, extra = {}) => `__CHANNEL_ENTRY__${JSON.stringify({ id: videoId(number), title: `视频 ${number}`, channel_id: CHANNEL, channel: '示例频道', ...extra })}\n`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(condition, message = 'condition was not reached') {
  for (let n = 0; n < 400; n++) { if (condition()) return; await delay(5); }
  throw new Error(message);
}

async function setup(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cinder-channel-test-'));
  const calls = [];
  const children = [];
  const scanner = new ChannelScanner({
    binaries: { ytDlp: path.join(directory, 'yt-dlp.exe'), jsRuntime: path.join(directory, 'node.exe') },
    statePath: path.join(directory, 'channels.json'),
    spawnFn(executable, args, spawnOptions) {
      const child = new EventEmitter();
      child.pid = children.length + 1000;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.close = (code = 0) => { child.exitCode = code; child.emit('close', code); };
      calls.push({ executable, args, options: spawnOptions });
      children.push(child);
      return child;
    },
    terminateFn: async child => { child.close(null); },
    changeThrottleMs: 10,
    checkpointMs: 20,
    idleTimeoutMs: 2000,
    stopTimeoutMs: 30,
    ...options
  });
  await scanner.init();
  t.after(async () => { await scanner.shutdown(); await fs.rm(directory, { recursive: true, force: true }); });
  return { scanner, children, calls, directory };
}

test('normalizes all supported channel routes and strips shared tab/query suffixes', () => {
  assert.equal(normalizeChannelUrl('https://m.youtube.com/@测试频道/shorts?si=shared'), 'https://www.youtube.com/@%E6%B5%8B%E8%AF%95%E9%A2%91%E9%81%93');
  assert.equal(normalizeChannelUrl(`https://youtube.com/channel/${CHANNEL}/streams/`), `https://www.youtube.com/channel/${CHANNEL}`);
  assert.equal(normalizeChannelUrl('https://youtube.com/user/example/videos'), 'https://www.youtube.com/user/example');
  assert.equal(normalizeChannelUrl('https://youtube.com/c/example'), 'https://www.youtube.com/c/example');
});

test('rejects alternate hosts, credentials, ports, traversal, playlists and option injection', () => {
  for (const value of ['http://youtube.com/@example', 'https://youtube.com.evil/@example', 'https://user:pass@youtube.com/@example', 'https://youtube.com:443/@example', 'https://youtu.be/12345678901', 'https://youtube.com/watch?v=12345678901', 'https://youtube.com/playlist?list=PL123', 'https://youtube.com/@example?list=PL123', 'https://youtube.com/@example/playlists', 'https://youtube.com/x/../@example', 'https://youtube.com/@example%2f..', 'https://youtube.com/@example\n--exec=evil', 'https://youtube.com\\@example']) {
    assert.throws(() => normalizeChannelUrl(value), undefined, value);
  }
  const args = buildScanArgs(`${URL}?si=--exec%3Devil`, 'videos');
  assert.equal(args.at(-2), '--');
  assert.equal(args.at(-1), `${URL}/videos`);
  assert(!args.some(arg => arg.includes('evil')));
  for (const flag of ['--flat-playlist', '--skip-download', '--lazy-playlist', '--ignore-config', '--no-cookies', '--no-cookies-from-browser', '--no-plugin-dirs', '--no-remote-components', '--no-cache-dir']) assert(args.includes(flag));
  assert.throws(() => buildScanArgs(URL, '--exec=evil'));
});

test('streams multiple pages beyond 1000 items, preserves split UTF-8 and compact events', async t => {
  const { scanner, children, calls } = await setup(t);
  const changes = [];
  scanner.on('change', state => changes.push(state));
  assert.equal(scanner.start({ url: URL, tabs: ['videos'] }).status, 'scanning');
  await until(() => children.length === 1);
  const first = Buffer.from(line(1, { title: '多字节：猫🐈' }));
  for (const byte of first) children[0].stdout.write(Buffer.from([byte]));
  for (let page = 0; page < 4; page++) {
    children[0].stdout.write(Array.from({ length: 500 }, (_, n) => line(page * 500 + n + 2)).join(''));
    await delay(12);
    assert.equal(scanner.entries.length, (page + 1) * 500 + 1);
  }
  assert.equal(scanner.snapshot().status, 'scanning');
  children[0].close();
  await until(() => !scanner.busy);
  assert.equal(scanner.snapshot().status, 'ready');
  assert.equal(scanner.entries.length, 2001);
  assert.equal(scanner.entries[0].title, '多字节：猫🐈');
  assert(changes.length < 30, `emitted ${changes.length} changes`);
  assert(changes.every(state => !Object.hasOwn(state, 'entries')));
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
  const saved = JSON.parse(await fs.readFile(scanner.statePath, 'utf8'));
  assert.equal(saved.entries.length, 2001);
  assert.equal(saved.state.status, 'ready');
});

test('scans selected tabs sequentially, deduplicates, filters active/scheduled live and includes VOD', async t => {
  const { scanner, children } = await setup(t);
  scanner.start({ url: URL, tabs: ['videos', 'shorts', 'streams'] });
  await until(() => children.length === 1);
  children[0].stdout.write(line(1) + line(2, { is_live: true }) + line(3, { live_status: 'is_upcoming' }));
  assert.equal(children.length, 1);
  children[0].close();
  await until(() => children.length === 2);
  children[1].stdout.write(line(1) + line(4));
  children[1].close();
  await until(() => children.length === 3);
  children[2].stdout.write(line(5, { live_status: 'was_live' }) + line(6, { live_status: 'post_live' }) + line(7, { is_upcoming: true }));
  children[2].close();
  await until(() => !scanner.busy);
  assert.deepEqual(scanner.entries.map(entry => entry.id), [1, 4, 5, 6].map(videoId));
  assert.equal(scanner.snapshot().skipped, 4);
  assert.equal(scanner.entries[2].tab, 'streams');
  assert.equal(scanner.snapshot().channelId, CHANNEL);
});

test('missing tab is warning while later tabs still complete', async t => {
  const { scanner, children } = await setup(t);
  scanner.start({ url: URL, tabs: ['shorts', 'videos'] });
  await until(() => children.length === 1);
  children[0].stderr.write('ERROR: [youtube:tab] This channel does not have a shorts tab\n');
  children[0].close(1);
  await until(() => children.length === 2);
  children[1].stdout.write(line(1));
  children[1].close();
  await until(() => !scanner.busy);
  assert.equal(scanner.snapshot().status, 'ready');
  assert.equal(scanner.snapshot().partial, false);
  assert.match(scanner.snapshot().warnings.join(''), /Shorts/);
});

test('zero-exit warnings flag partial enumeration and earlier errors cannot disappear from stderr tail', async t => {
  const { scanner, children } = await setup(t);
  scanner.start({ url: URL, tabs: ['videos'] });
  await until(() => children.length === 1);
  children[0].stdout.write(line(1));
  children[0].stderr.write('WARNING: Incomplete data received. Giving up after 2 retries\n');
  children[0].close();
  await until(() => !scanner.busy);
  assert.equal(scanner.snapshot().status, 'ready');
  assert.equal(scanner.snapshot().partial, true);
  scanner.start({ url: URL, tabs: ['videos'] });
  await until(() => children.length === 2);
  children[1].stderr.write('ERROR: request failed\n' + 'continued diagnostics\n'.repeat(1000));
  children[1].close();
  await until(() => !scanner.busy);
  assert.equal(scanner.snapshot().status, 'error');
  assert.equal(scanner.snapshot().partial, true);
});

test('request failure retains partial results without declaring success or exposing stderr', async t => {
  const { scanner, children } = await setup(t);
  scanner.start({ url: URL, tabs: ['videos', 'shorts'] });
  await until(() => children.length === 1);
  children[0].stdout.write(line(1));
  children[0].stderr.write('\x1b[31mERROR: HTTP Error 429 https://user:secret@bad.example/?token=private\x1b[0m\n');
  children[0].close(1);
  await until(() => !scanner.busy);
  assert.equal(scanner.snapshot().status, 'error');
  assert.match(scanner.snapshot().error, /限制/);
  assert(!JSON.stringify(scanner.snapshot()).includes('secret'));
  assert.equal(scanner.entries.length, 1);
  assert.equal(children.length, 1);
});

test('rejects malformed/oversized records, invalid ids and cap overflow, preserving valid prefix', async t => {
  for (const [bad, options, expected] of [
    ['__CHANNEL_ENTRY__{broken}\n', {}, /损坏/],
    ['__CHANNEL_ENTRY__' + 'x'.repeat(400), { maxLineLength: 300 }, /过长/],
    [line(2, { id: '--exec=evil' }), {}, /编号/],
    [line(2), { maxEntries: 1 }, /上限/]
  ]) {
    const { scanner, children } = await setup(t, options);
    scanner.start({ url: URL, tabs: ['videos'] });
    await until(() => children.length === 1);
    children[0].stdout.write(line(1));
    children[0].stdout.write(bad);
    await until(() => !scanner.busy);
    assert.equal(scanner.snapshot().status, 'error');
    assert.match(scanner.snapshot().error, expected);
    assert.equal(scanner.entries.length, 1);
  }
});

test('cancel waits for confirmed child closure and keeps results', async t => {
  let requestStop;
  const { scanner, children } = await setup(t, { stopTimeoutMs: 1000, terminateFn: child => { requestStop = child; } });
  scanner.start({ url: URL, tabs: ['videos', 'shorts'] });
  await until(() => children.length === 1);
  children[0].stdout.write(line(1));
  const pending = scanner.cancel();
  await until(() => requestStop);
  assert.equal(scanner.snapshot().status, 'scanning');
  assert.throws(() => scanner.start({ url: URL, tabs: ['videos'] }), /正在进行/);
  children[0].close(null);
  const state = await pending;
  assert.equal(state.status, 'cancelled');
  assert.equal(state.discovered, 1);
  assert.equal(scanner.busy, false);
  assert.equal(children.length, 1);
});

test('unconfirmed stop remains unsafe and blocks replacement', async t => {
  const { scanner, children } = await setup(t, { terminateFn: async () => {} });
  scanner.start({ url: URL, tabs: ['videos'] });
  await until(() => children.length === 1);
  const state = await scanner.cancel();
  assert.equal(state.status, 'error');
  assert.equal(scanner.unsafeStop, true);
  assert.equal(scanner.busy, true);
  assert.throws(() => scanner.start({ url: URL, tabs: ['videos'] }), /无法确认/);
  children[0].close(null);
});

test('child closure alone does not release scanner until process-tree termination finishes', async t => {
  let completeTreeStop;
  const { scanner, children } = await setup(t, { stopTimeoutMs: 1000, terminateFn: child => {
    child.close(null);
    return new Promise(resolve => { completeTreeStop = resolve; });
  } });
  scanner.start({ url: URL, tabs: ['videos'] });
  await until(() => children.length === 1);
  const pending = scanner.cancel();
  await until(() => completeTreeStop);
  assert.equal(scanner.busy, true);
  assert.equal(scanner.snapshot().status, 'scanning');
  completeTreeStop();
  assert.equal((await pending).status, 'cancelled');
  assert.equal(scanner.busy, false);
});

test('idle timeout stops scan and preserves a failure outcome', async t => {
  const { scanner, children } = await setup(t, { idleTimeoutMs: 20 });
  scanner.start({ url: URL, tabs: ['videos'] });
  await until(() => children.length === 1);
  await until(() => !scanner.busy);
  assert.equal(scanner.snapshot().status, 'error');
  assert.match(scanner.snapshot().error, /没有响应/);
});

test('restores interrupted checkpoint with allowlisted entry data and validates saved URLs', async t => {
  const { scanner, children } = await setup(t, { checkpointMs: 10 });
  scanner.start({ url: URL, tabs: ['videos'] });
  await until(() => children.length === 1);
  children[0].stdout.write(line(1));
  await delay(40);
  const saved = JSON.parse(await fs.readFile(scanner.statePath, 'utf8'));
  assert.equal(saved.state.status, 'scanning');
  assert.equal(saved.entries.length, 1);
  const restored = new ChannelScanner({ statePath: scanner.statePath });
  const state = await restored.init();
  assert.equal(state.status, 'interrupted');
  assert.equal(state.discovered, 1);
  assert.match(state.error, /第一页/);
  await scanner.cancel();
  saved.entries[0].url = 'https://attacker.example/payload';
  await fs.writeFile(scanner.statePath, JSON.stringify(saved));
  const rejected = new ChannelScanner({ statePath: scanner.statePath });
  assert.equal((await rejected.init()).status, 'error');
  assert.equal(rejected.entries.length, 0);
});

test('playlist metadata backfills entries and never trusts an output URL', async t => {
  const { scanner, children } = await setup(t);
  scanner.start({ url: URL, tabs: ['videos'] });
  await until(() => children.length === 1);
  children[0].stdout.write(line(1, { channel_id: null, channel: null, url: 'https://attacker.example' }));
  children[0].stdout.write(`__CHANNEL_META__${JSON.stringify({ channel_id: CHANNEL, channel: '最终频道' })}`);
  children[0].close();
  await until(() => !scanner.busy);
  assert.equal(scanner.entries[0].channelId, CHANNEL);
  assert.equal(scanner.entries[0].channelTitle, '最终频道');
  assert.equal(scanner.entries[0].url, `https://www.youtube.com/watch?v=${videoId(1)}`);
});

test('engine lock and tab validation reject before spawning or clearing previous entries', async t => {
  const { scanner, children } = await setup(t, { canStart: () => false });
  assert.throws(() => scanner.start({ url: URL, tabs: [] }), /至少/);
  assert.throws(() => scanner.start({ url: URL, tabs: ['videos', 'videos'] }), /至少/);
  assert.throws(() => scanner.start({ url: URL, tabs: ['videos'] }), /引擎正忙/);
  assert.equal(children.length, 0);
  assert.equal(scanner.snapshot().status, 'idle');
});
