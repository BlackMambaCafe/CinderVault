'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseEngineJson, terminateProcessTree } = require('./core');

const TABS = new Set(['videos', 'shorts', 'streams']);
const STATUSES = new Set(['idle', 'scanning', 'ready', 'cancelled', 'error', 'interrupted']);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const ENTRY_PREFIX = '__CHANNEL_ENTRY__';
const META_PREFIX = '__CHANNEL_META__';
const MAX_ENTRIES = 100000;
const MAX_LINE = 128 * 1024;
const SCAN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PAGE_SIZE = 50;
const TAB_NAMES = { videos: '普通视频', shorts: 'Shorts', streams: '直播回放' };

function cleanText(value, limit = 500) {
  return typeof value === 'string' ? value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit) : '';
}

function normalizeChannelUrl(input) {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('请填写完整的 YouTube 频道 HTTPS 链接');
  const raw = input.trim();
  if (/[\u0000-\u0020\u007f\\]/.test(raw)) throw new Error('频道链接包含无效字符');
  let url;
  try { url = new URL(raw); } catch { throw new Error('频道链接格式不正确'); }
  const match = raw.match(/^https:\/\/([^/?#]+)([^?#]*)/i);
  if (!match || url.protocol !== 'https:' || url.username || url.password || match[1].includes(':') || !['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname.toLowerCase())) {
    throw new Error('仅支持不含登录信息或端口的 YouTube 官方 HTTPS 频道链接');
  }
  if (url.searchParams.has('list')) throw new Error('请填写频道主页，不支持播放列表链接');
  let segments;
  try { segments = match[2].replace(/\/$/, '').split('/').slice(1).map(decodeURIComponent); }
  catch { throw new Error('频道链接编码不正确'); }
  if (segments.length > 1 && TABS.has(segments.at(-1))) segments.pop();
  const namePattern = /^[\p{L}\p{N}\p{M}._-]{1,100}$/u;
  const isHandle = segments.length === 1 && segments[0].startsWith('@') && namePattern.test(segments[0].slice(1));
  const isChannel = segments.length === 2 && segments[0] === 'channel' && CHANNEL_ID.test(segments[1]);
  const isLegacy = segments.length === 2 && ['user', 'c'].includes(segments[0]) && namePattern.test(segments[1]);
  if ((!isHandle && !isChannel && !isLegacy) || segments.some(s => s === '.' || s === '..')) {
    throw new Error('请使用 @用户名、/channel/、/user/ 或 /c/ 频道主页链接');
  }
  return `https://www.youtube.com/${segments.map(s => encodeURIComponent(s).replace(/^%40/, '@')).join('/')}`;
}

function validateTabs(tabs) {
  if (!Array.isArray(tabs) || tabs.length < 1 || tabs.length > 3 || tabs.some(tab => !TABS.has(tab)) || new Set(tabs).size !== tabs.length) {
    throw new Error('请选择普通视频、Shorts 或直播回放，至少选择一项');
  }
  return [...tabs];
}

function buildScanArgs(url, tab, binaries = {}) {
  const canonical = normalizeChannelUrl(url);
  if (!TABS.has(tab)) throw new Error('频道分类无效');
  const fields = '{"id":%(id)j,"title":%(title)j,"channel_id":%(channel_id,playlist_channel_id)j,"channel":%(channel,playlist_channel,uploader)j,"is_live":%(is_live)j,"is_upcoming":%(is_upcoming)j,"live_status":%(live_status)j}';
  const args = [
    '--ignore-config', '--no-cache-dir', '--no-plugin-dirs', '--no-remote-components', '--no-cookies', '--no-cookies-from-browser',
    '--flat-playlist', '--skip-download', '--lazy-playlist', '--no-wait-for-video', '--no-colors', '--encoding', 'utf-8',
    '--output-na-placeholder', 'null', '--quiet', '--no-progress', '--socket-timeout', '30', '--retries', '2', '--extractor-retries', '2', '--sleep-requests', '1',
    '--no-js-runtimes', '--print', `video:${ENTRY_PREFIX}${fields}`,
    '--print', `playlist:${META_PREFIX}{"channel_id":%(channel_id)j,"channel":%(channel,uploader)j}`
  ];
  if (binaries.jsRuntime) args.push('--js-runtimes', `node:${binaries.jsRuntime}`);
  args.push('--', `${canonical}/${tab}`);
  return args;
}

function requestError(stderr, code) {
  if (/429|Too Many Requests|rate.limit/i.test(stderr)) return '平台限制了请求，请稍后重新扫描';
  if (/sign in|not a bot|login|cookies|authentication/i.test(stderr)) return '频道需要登录或平台验证；本工具仅扫描公开可访问的内容';
  if (/timed? ?out|timeout|ETIMEDOUT/i.test(stderr)) return '频道请求超时，请检查网络后重新扫描';
  if (/certificate|SSL|TLS/i.test(stderr)) return '安全连接校验失败，请检查系统时间和网络';
  if (/404|does not exist|not found|unavailable/i.test(stderr)) return '频道不存在、不可访问或在当前地区不可用';
  if (/403|forbidden/i.test(stderr)) return '平台拒绝了频道访问，请稍后重新扫描';
  if (/network|connection|resolve|ENOTFOUND|ECONNRESET|urlopen/i.test(stderr)) return '网络连接失败，请检查网络后重新扫描';
  return `频道扫描失败${Number.isInteger(code) ? `（代码 ${code}）` : ''}，已保留目前发现的视频，可稍后重新扫描`;
}

class ChannelScanner extends EventEmitter {
  constructor({ binaries = {}, statePath, spawnFn = spawn, terminateFn = terminateProcessTree, canStart = () => true, idleTimeoutMs = 120000, scanTimeoutMs = 6 * 60 * 60 * 1000, stopTimeoutMs = 15000, checkpointMs = 2000, changeThrottleMs = 150, maxEntries = MAX_ENTRIES, maxLineLength = MAX_LINE } = {}) {
    super();
    this.binaries = binaries;
    this.statePath = statePath;
    this.spawnFn = spawnFn;
    this.terminateFn = terminateFn;
    this.canStart = canStart;
    this.idleTimeoutMs = idleTimeoutMs;
    this.scanTimeoutMs = scanTimeoutMs;
    this.stopTimeoutMs = stopTimeoutMs;
    this.checkpointMs = checkpointMs;
    this.changeThrottleMs = changeThrottleMs;
    this.maxEntries = Math.min(MAX_ENTRIES, maxEntries);
    this.maxLineLength = maxLineLength;
    this.entries = [];
    this._ids = new Set();
    this._state = { status: 'idle', scanId: '', url: '', tabs: [], discovered: 0, skipped: 0, channelTitle: '', channelId: '', error: '', warnings: [], activeTab: '', partial: false };
    this._initialized = false;
    this._closed = false;
    this._active = null;
    this._runPromise = null;
    this._cancelRequested = false;
    this._unsafeStop = false;
    this._savePromise = Promise.resolve();
    this._changeTimer = null;
    this._checkpointTimer = null;
  }

  get busy() { return !!this._runPromise || !!this._active || this._unsafeStop; }
  get unsafeStop() { return this._unsafeStop; }
  snapshot() { return { ...this._state, tabs: [...this._state.tabs], warnings: [...this._state.warnings], discovered: this.entries.length, partial: !['idle', 'ready'].includes(this._state.status) || !!this._state.partial }; }

  list(options = {}) {
    if (!this._initialized || this._closed) throw new Error('频道扫描器尚未就绪或正在退出');
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('频道列表参数无效');
    const { scanId, page = 1, query = '' } = options;
    if (scanId !== undefined && (typeof scanId !== 'string' || scanId !== this._state.scanId)) {
      const error = new Error('频道扫描结果已更新，请刷新列表后重新选择');
      error.code = 'STALE_SCAN';
      throw error;
    }
    if (!Number.isSafeInteger(page)) throw new Error('频道列表页码无效');
    if (typeof query !== 'string' || query.length > 500) throw new Error('搜索内容最多 500 个字符');
    const term = query.trim().toLocaleLowerCase();
    const filtered = term ? this.entries.filter(entry => entry.title.toLocaleLowerCase().includes(term) || entry.id.toLocaleLowerCase().includes(term)) : this.entries;
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const selectedPage = Math.min(pages, Math.max(1, page));
    return {
      scanId: this._state.scanId,
      entries: filtered.slice((selectedPage - 1) * PAGE_SIZE, selectedPage * PAGE_SIZE).map(({ id, title, url, tab }) => ({ id, title, url, tab })),
      total: this.entries.length, filteredTotal: filtered.length, page: selectedPage, pages, pageSize: PAGE_SIZE
    };
  }

  async init() {
    if (this._initialized) return this.snapshot();
    if (this.statePath) {
      try {
        const stat = await fs.stat(this.statePath);
        if (stat.size > 256 * 1024 * 1024) throw new Error('扫描记录过大');
        const saved = JSON.parse(await fs.readFile(this.statePath, 'utf8'));
        if (!saved || saved.version !== 1 || !saved.state || !Array.isArray(saved.entries) || saved.entries.length > MAX_ENTRIES) throw new Error('扫描记录格式无效');
        const state = saved.state;
        if (state.scanId !== undefined && !(state.status === 'idle' && state.scanId === '') && (typeof state.scanId !== 'string' || !SCAN_ID.test(state.scanId))) throw new Error('扫描编号无效');
        if (!STATUSES.has(state.status) || !Number.isSafeInteger(state.skipped) || state.skipped < 0 || typeof state.url !== 'string' || typeof state.channelTitle !== 'string' || state.channelTitle.length > 500 || typeof state.error !== 'string' || state.error.length > 1000 || (state.partial != null && typeof state.partial !== 'boolean') || (state.channelId !== '' && !CHANNEL_ID.test(state.channelId)) || !Array.isArray(state.warnings) || state.warnings.length > 30 || state.warnings.some(w => typeof w !== 'string' || w.length > 500)) throw new Error('扫描状态无效');
        const url = state.url ? normalizeChannelUrl(state.url) : '';
        const tabs = state.status === 'idle' && !url ? [] : validateTabs(state.tabs);
        if (state.status !== 'idle' && !url) throw new Error('频道链接缺失');
        const ids = new Set();
        const entries = saved.entries.map(entry => {
          if (!entry || typeof entry.id !== 'string' || !VIDEO_ID.test(entry.id) || entry.url !== `https://www.youtube.com/watch?v=${entry.id}` || ids.has(entry.id) || !tabs.includes(entry.tab) || typeof entry.title !== 'string' || entry.title.length > 500 || typeof entry.channelTitle !== 'string' || entry.channelTitle.length > 500 || (entry.channelId !== '' && !CHANNEL_ID.test(entry.channelId))) throw new Error('扫描条目无效');
          ids.add(entry.id);
          return { id: entry.id, url: entry.url, title: cleanText(entry.title), channelId: entry.channelId, channelTitle: cleanText(entry.channelTitle), tab: entry.tab };
        });
        this.entries = entries;
        this._ids = ids;
        this._state = { status: state.status === 'scanning' ? 'interrupted' : state.status, scanId: state.scanId === undefined ? (state.status === 'idle' ? '' : randomUUID()) : state.scanId, url, tabs, discovered: entries.length, skipped: state.skipped, channelTitle: cleanText(state.channelTitle), channelId: CHANNEL_ID.test(state.channelId) ? state.channelId : '', error: cleanText(state.error, 1000), warnings: state.warnings.map(w => cleanText(w)), activeTab: '', partial: state.partial === true };
        if (state.status === 'scanning') this._state.error = '上次扫描因软件退出而中断，已保留发现的视频；重新扫描会从频道第一页开始';
        if (state.scanId === undefined) await this._persist();
      } catch (err) {
        if (err.code !== 'ENOENT') {
          this._state.status = 'error';
          this._state.error = '未能读取上次频道扫描记录，已保留原文件；请重新扫描';
          try { await fs.rename(this.statePath, `${this.statePath}.corrupt-${Date.now()}`); } catch { /* Keep the source if quarantine is unavailable. */ }
        }
      }
    }
    this._initialized = true;
    return this.snapshot();
  }

  start({ url, tabs } = {}) {
    if (!this._initialized || this._closed) throw new Error('频道扫描器尚未就绪或正在退出');
    if (this.busy) throw new Error(this._unsafeStop ? '无法确认旧扫描进程已停止，请退出软件并确认进程结束后重开' : '频道扫描正在进行，请先取消并等待结束');
    const normalized = normalizeChannelUrl(url);
    const selected = validateTabs(tabs);
    if (this.canStart() === false) throw new Error('下载引擎正忙，请等待引擎更新结束后扫描');
    if (!this.binaries.ytDlp || !path.isAbsolute(this.binaries.ytDlp)) throw new Error('下载引擎缺失，请重新解压完整安装包');
    this.entries = [];
    this._ids = new Set();
    this._cancelRequested = false;
    this._state = { status: 'scanning', scanId: randomUUID(), url: normalized, tabs: selected, discovered: 0, skipped: 0, channelTitle: '', channelId: normalized.match(/\/channel\/(UC[A-Za-z0-9_-]{22})$/)?.[1] || '', error: '', warnings: [], activeTab: '', partial: false };
    this._checkpointTimer = setInterval(() => { void this._persist(); }, this.checkpointMs);
    this._checkpointTimer.unref?.();
    // Defer spawning until the in-flight marker is set, even for synchronous test children.
    this._runPromise = Promise.resolve().then(() => this._scan()).finally(() => { this._runPromise = null; this._emitNow(); });
    void this._persist();
    this._emitNow();
    return this.snapshot();
  }

  async cancel() {
    if (!this._runPromise && !this._active) return this.snapshot();
    this._cancelRequested = true;
    if (this._active) await this._stop(this._active);
    await this._runPromise;
    return this.snapshot();
  }

  async shutdown() {
    this._closed = true;
    await this.cancel();
    clearTimeout(this._changeTimer);
    clearInterval(this._checkpointTimer);
    await this._persist();
    return this.snapshot();
  }

  _warn(message) {
    const clean = cleanText(message);
    if (clean && !this._state.warnings.includes(clean) && this._state.warnings.length < 30) this._state.warnings.push(clean);
  }

  _emitNow() {
    clearTimeout(this._changeTimer);
    this._changeTimer = null;
    this.emit('change', this.snapshot());
  }

  _changed() {
    if (!this._changeTimer) this._changeTimer = setTimeout(() => this._emitNow(), this.changeThrottleMs);
  }

  _metadata(value) {
    if (CHANNEL_ID.test(value.channel_id)) this._state.channelId = value.channel_id;
    if (cleanText(value.channel)) this._state.channelTitle = cleanText(value.channel);
  }

  _line(line, tab) {
    if (!line.trim()) return;
    if (line.length > this.maxLineLength) throw new Error('频道扫描返回了过长的数据行，已停止并保留已发现的视频');
    const isEntry = line.startsWith(ENTRY_PREFIX);
    if (!isEntry && !line.startsWith(META_PREFIX)) throw new Error('频道扫描返回了无法识别的数据，已停止并保留已发现的视频');
    let value;
    try { value = parseEngineJson(line.slice(isEntry ? ENTRY_PREFIX.length : META_PREFIX.length)); }
    catch { throw new Error('频道扫描返回了损坏的数据，已停止并保留已发现的视频'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('频道扫描数据格式无效');
    this._metadata(value);
    if (!isEntry) return;
    if (typeof value.id !== 'string' || !VIDEO_ID.test(value.id)) throw new Error('频道扫描返回了无效的视频编号，已停止并保留已发现的视频');
    if (value.is_live === true || value.is_upcoming === true || ['is_live', 'is_upcoming'].includes(value.live_status)) {
      this._state.skipped++;
      this._changed();
      return;
    }
    if (this._ids.has(value.id)) { this._state.skipped++; this._changed(); return; }
    if (this.entries.length >= this.maxEntries) throw new Error(`频道超过 ${this.maxEntries.toLocaleString('en-US')} 个视频的扫描上限，已停止并保留已发现的视频`);
    const entry = { id: value.id, url: `https://www.youtube.com/watch?v=${value.id}`, title: cleanText(value.title) || value.id, channelId: CHANNEL_ID.test(value.channel_id) ? value.channel_id : this._state.channelId, channelTitle: cleanText(value.channel) || this._state.channelTitle, tab };
    this._ids.add(entry.id);
    this.entries.push(entry);
    this._changed();
  }

  async _scan() {
    const deadline = setTimeout(() => {
      if (this._active) { this._active.failure = '频道扫描已超过最长等待时间，已保留已发现的视频'; void this._stop(this._active); }
    }, this.scanTimeoutMs);
    try {
      for (const tab of this._state.tabs) {
        if (this._cancelRequested) break;
        this._state.activeTab = tab;
        this._emitNow();
        const result = await this._scanTab(tab);
        if (this._cancelRequested) break;
        if (result.error) throw new Error(result.error);
        if (result.missing) this._warn(`该频道没有${TAB_NAMES[tab]}分类，已跳过`);
        if (result.warning) {
          this._state.partial = true;
          this._warn(`${TAB_NAMES[tab]}扫描中引擎报告了提示，列表可能不完整，可稍后重新扫描`);
        }
      }
      if (this._unsafeStop) throw new Error('无法确认扫描进程已完全停止，请退出软件并确认进程结束后重开');
      this._state.status = this._cancelRequested ? 'cancelled' : 'ready';
      if (this._cancelRequested) this._state.error = '扫描已取消，已保留目前发现的视频';
    } catch (err) {
      this._state.status = 'error';
      this._state.error = cleanText(err.message, 1000) || '频道扫描失败';
    } finally {
      clearTimeout(deadline);
      clearInterval(this._checkpointTimer);
      this._checkpointTimer = null;
      this._state.activeTab = '';
      // Playlist metadata can arrive after the last entry, including for an empty tab.
      for (const entry of this.entries) {
        if (!entry.channelId) entry.channelId = this._state.channelId;
        if (!entry.channelTitle) entry.channelTitle = this._state.channelTitle;
      }
      await this._persist();
      this._emitNow();
    }
  }

  _scanTab(tab) {
    return new Promise(resolve => {
      let child;
      try { child = this.spawnFn(this.binaries.ytDlp, buildScanArgs(this._state.url, tab, this.binaries), { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (err) { resolve({ error: err.code === 'ENOENT' ? '下载引擎缺失，请重新解压完整安装包' : '无法启动频道扫描引擎' }); return; }
      const record = { child, closed: false, failure: '', finish: null, stopPromise: null, countBefore: this.entries.length };
      this._active = record;
      const decoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      let pending = '';
      let stderr = '';
      let stderrPending = '';
      let hasWarning = false;
      let hasMissingError = false;
      let hasOtherError = false;
      let idleTimer;
      let settled = false;
      const missingTab = /This channel does not have a (?:videos|shorts|streams|live) tab|This channel has no videos/i;
      const inspectDiagnostic = diagnostic => {
        if (/\bWARNING:/i.test(diagnostic)) hasWarning = true;
        if (/\bERROR:/i.test(diagnostic)) {
          if (missingTab.test(diagnostic)) hasMissingError = true;
          else hasOtherError = true;
        }
      };
      const consumeStderr = text => {
        stderr = (stderr + text).slice(-8192);
        stderrPending += text;
        let at;
        while ((at = stderrPending.indexOf('\n')) !== -1) {
          inspectDiagnostic(stderrPending.slice(0, at));
          stderrPending = stderrPending.slice(at + 1);
        }
        // Diagnostic output is bounded too; preserve classification before truncating.
        if (stderrPending.length > 8192) { inspectDiagnostic(stderrPending); stderrPending = stderrPending.slice(-8192); }
      };
      const resetIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => { record.failure ||= '频道扫描长时间没有响应，已停止并保留已发现的视频'; void this._stop(record); }, this.idleTimeoutMs);
      };
      const consume = text => {
        pending += text;
        let at;
        while ((at = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, at).replace(/\r$/, '');
          pending = pending.slice(at + 1);
          this._line(line, tab);
        }
        if (pending.length > this.maxLineLength) throw new Error('频道扫描返回了过长的数据行，已停止并保留已发现的视频');
      };
      record.finish = result => {
        if (settled) return;
        settled = true;
        clearTimeout(idleTimer);
        if (record.closed) this._active = null;
        resolve(result);
      };
      child.stdout.on('data', chunk => {
        if (settled || this._cancelRequested || record.failure) return;
        resetIdle();
        try { consume(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))); }
        catch (err) { record.failure = err.message; void this._stop(record); }
      });
      child.stderr.on('data', chunk => {
        if (settled) return;
        resetIdle();
        consumeStderr(stderrDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      });
      child.once('error', err => {
        record.failure ||= err.code === 'ENOENT' ? '下载引擎缺失，请重新解压完整安装包' : '频道扫描引擎发生错误';
        // Spawn failures have no running process and may never provide a useful PID.
        if (!child.pid) { record.closed = true; record.finish({ error: record.failure }); }
        else void this._stop(record);
      });
      child.once('close', code => {
        record.closed = true;
        if (settled) { if (this._active === record) this._active = null; return; }
        if (!record.failure && !this._cancelRequested) {
          try { consume(decoder.end()); if (pending.trim()) this._line(pending.replace(/\r$/, ''), tab); }
          catch (err) { record.failure = err.message; }
        }
        consumeStderr(stderrDecoder.end());
        inspectDiagnostic(stderrPending);
        const diagnostic = cleanText(stderr, 8192);
        const missing = this.entries.length === record.countBefore && hasMissingError && !hasOtherError && !hasWarning;
        const result = { error: record.failure || ((!missing && (code !== 0 || hasOtherError || hasMissingError)) ? requestError(diagnostic, code) : ''), missing, warning: !missing && hasWarning };
        // Keep the updater/start lease until taskkill (or a process-group stop)
        // finishes too; the parent can close before its descendants are reaped.
        if (record.stopPromise) void record.stopPromise.then(() => record.finish(result));
        else record.finish(result);
      });
      resetIdle();
    });
  }

  async _stop(record) {
    if (record.stopPromise) return record.stopPromise;
    record.stopPromise = (async () => {
      if (record.closed) return;
      let timer;
      const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(false), this.stopTimeoutMs); });
      // A resolved terminator is insufficient: the child's close event confirms shutdown.
      const stopped = new Promise(resolve => {
        record.child.once('close', () => resolve(true));
        if (record.closed) resolve(true);
      });
      const terminated = Promise.resolve().then(() => this.terminateFn(record.child)).then(() => true, () => false);
      const confirmed = await Promise.race([Promise.all([stopped, terminated]).then(([closed, treeStopped]) => closed && treeStopped), timeout]);
      clearTimeout(timer);
      if (!confirmed) {
        this._unsafeStop = true;
        record.failure = '无法确认扫描进程已完全停止，请退出软件并确认进程结束后重开';
        record.finish({ error: record.failure });
      }
    })();
    return record.stopPromise;
  }

  _persist() {
    if (!this.statePath) return Promise.resolve();
    // Capture at execution time so queued checkpoints cannot overwrite newer results.
    this._savePromise = this._savePromise.then(async () => {
      const data = JSON.stringify({ version: 1, state: this.snapshot(), entries: this.entries });
      await fs.mkdir(path.dirname(this.statePath), { recursive: true });
      const temp = `${this.statePath}.tmp`;
      await fs.writeFile(temp, data, 'utf8');
      await fs.rename(temp, this.statePath);
    }).catch(() => { this._warn('无法保存频道扫描记录；退出软件后可能需要重新扫描'); this._changed(); });
    return this._savePromise;
  }
}

module.exports = { ChannelScanner, normalizeChannelUrl, buildScanArgs };
