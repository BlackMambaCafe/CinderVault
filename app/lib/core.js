'use strict';

// No shell commands, credentials, browser profiles, or downloader configuration are read.
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');

const QUALITIES = new Set(['best', '1080', '720', '480', 'audio']);
const FINISHED = new Set(['completed', 'failed', 'cancelled']);
const ACTIVE = new Set(['downloading', 'processing', 'running']);
const STATUSES = new Set(['queued', 'paused', 'downloading', 'processing', 'completed', 'failed', 'cancelled']);
const MAX_LOG = 8192;
const MAX_JOBS = 100000;
const VIDEO_ID = /^[\w-]{11}$/;

function normalizeUrl(input) {
  if (typeof input !== 'string' || input.length > 2048 || /[\u0000-\u0020\u007f]/.test(input.trim())) {
    throw new Error('链接格式不正确，请每行填写一个完整 HTTPS 视频链接');
  }
  let u;
  try { u = new URL(input.trim()); } catch { throw new Error('链接格式不正确，请使用完整 HTTPS 视频链接'); }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) {
    throw new Error('仅支持不含登录信息的标准 HTTPS 视频链接');
  }
  const host = u.hostname.toLowerCase();
  const pathname = u.pathname.replace(/\/+$/, '') || '/';
  let url;
  let platform;
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be'].includes(host)) {
    const id = host.endsWith('youtu.be') ? pathname.slice(1) : pathname === '/watch' ? u.searchParams.get('v') : pathname.match(/^\/(?:shorts|embed|live)\/([\w-]+)$/)?.[1];
    if (!id || !VIDEO_ID.test(id)) throw new Error('请使用单个 YouTube 视频链接，不支持频道或播放列表');
    url = `https://www.youtube.com/watch?v=${id}`;
    platform = 'YouTube';
  } else if (['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'].includes(host)) {
    if (!/^\/video\/(?:BV[a-zA-Z0-9]{10}|av\d+)$/.test(pathname) && !/^\/bangumi\/play\/ep\d+$/.test(pathname)) {
      throw new Error('请使用 B站单个 BV、av 或 ep 视频链接，不支持合集或直播间');
    }
    url = `https://www.bilibili.com${pathname}`;
    const page = u.searchParams.get('p');
    if (page && !/^[1-9]\d{0,3}$/.test(page)) throw new Error('B站分P参数不正确');
    if (page && page !== '1') url += `?p=${page}`;
    platform = 'Bilibili';
  } else if (['b23.tv', 'www.b23.tv'].includes(host)) {
    if (!/^\/[A-Za-z0-9_-]{3,64}$/.test(pathname)) throw new Error('B站短链接格式不正确');
    url = `https://b23.tv${pathname}`;
    platform = 'Bilibili';
  } else if (['twitch.tv', 'www.twitch.tv', 'm.twitch.tv', 'clips.twitch.tv'].includes(host)) {
    if (host === 'clips.twitch.tv' && /^\/[A-Za-z0-9_-]+$/.test(pathname)) {
      url = `https://clips.twitch.tv${pathname}`;
    } else if (/^\/videos\/\d+$/.test(pathname) || /^\/[A-Za-z0-9_]+\/clip\/[A-Za-z0-9_-]+$/.test(pathname)) {
      url = `https://www.twitch.tv${pathname}`;
    } else throw new Error('请使用 Twitch 回放或剪辑链接，暂不录制直播');
    platform = 'Twitch';
  } else throw new Error('仅支持 YouTube、B站和 Twitch 的官方视频链接');
  return { url, platform };
}

function parseUrls(text, existing = []) {
  if (typeof text !== 'string' || text.length > 200000) throw new Error('一次最多粘贴 200,000 个字符');
  const known = new Set(existing.map(v => typeof v === 'string' ? v : v.url));
  const result = { added: [], duplicates: [], errors: [] };
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (lines.length > 500) throw new Error('一次最多添加 500 个链接');
  for (const input of lines) {
    try {
      const value = normalizeUrl(input);
      if (known.has(value.url)) result.duplicates.push(value.url);
      else { known.add(value.url); result.added.push(value); }
    } catch (err) { result.errors.push({ input: input.slice(0, 2048), error: err.message }); }
  }
  return result;
}

function validateSettings(next, previous) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error('下载设置格式不正确');
  const result = { ...previous };
  if (Object.hasOwn(next, 'quality')) {
    if (!QUALITIES.has(next.quality)) throw new Error('请选择最高画质、1080p、720p、480p 或 MP3');
    result.quality = next.quality;
  }
  if (Object.hasOwn(next, 'concurrency')) {
    if (!Number.isInteger(next.concurrency) || next.concurrency < 1 || next.concurrency > 3) throw new Error('并发下载数必须是 1 到 3 之间的整数');
    result.concurrency = next.concurrency;
  }
  if (Object.hasOwn(next, 'outputDir')) {
    if (typeof next.outputDir !== 'string' || !next.outputDir.trim() || next.outputDir.length > 2048 || /[\u0000-\u001f]/.test(next.outputDir) || !path.isAbsolute(next.outputDir)) {
      throw new Error('请选择有效的绝对路径作为下载文件夹');
    }
    result.outputDir = path.resolve(next.outputDir);
  }
  return result;
}

function buildArgs(job, binaries) {
  const quality = QUALITIES.has(job.quality) ? job.quality : 'best';
  const datePrefix = job.namingVersion === 1 ? '' : '%(upload_date>%Y-%m-%d,release_date>%Y-%m-%d|日期未知)s ';
  const args = [
    '--ignore-config', '--no-cache-dir', '--no-plugin-dirs', '--no-remote-components', '--no-cookies', '--no-cookies-from-browser', '--no-playlist',
    '--playlist-items', '1', '--max-downloads', '1', '--match-filters', '!is_live', '--no-wait-for-video',
    '--no-colors', '--encoding', 'utf-8', '--output-na-placeholder', 'null', '--no-simulate', '--newline', '--progress', '--progress-delta', '0.5',
    '--no-overwrites', '--continue', '--windows-filenames', '--trim-filenames', '180',
    '--socket-timeout', '30', '--retries', '3', '--fragment-retries', '3', '--extractor-retries', '2',
    '--retry-sleep', 'http:exp=1:8', '--abort-on-unavailable-fragments', '--no-mtime',
    '--ffmpeg-location', binaries.ffmpeg,
    '--paths', job.outputDir,
    '--output', `${datePrefix}%(title).100B [%(id)s]-${quality}.%(ext)s`,
    '--print', 'before_dl:__META__{"title":%(title)j,"id":%(id)j,"upload_date":%(upload_date)j,"release_date":%(release_date)j}',
    '--print', 'after_move:__FILE__%(filepath)j',
    '--progress-template', 'download:__PROGRESS__{"status":%(progress.status|null)j,"downloaded":%(progress.downloaded_bytes|null)j,"total":%(progress.total_bytes|null)j,"estimate":%(progress.total_bytes_estimate|null)j,"speed":%(progress.speed|null)j,"eta":%(progress.eta|null)j}',
    '--progress-template', 'postprocess:__POSTPROCESS__%(progress.status|null)j'
  ];
  if (binaries.jsRuntime) args.push('--no-js-runtimes', '--js-runtimes', `node:${binaries.jsRuntime}`);
  if (job.channelId) args.push('--sleep-requests', '1', '--sleep-interval', '5', '--max-sleep-interval', '10');
  if (quality === 'audio') args.push('--format', 'bestaudio/best', '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0');
  else {
    const height = quality === 'best' ? '' : `[height<=${quality}]`;
    args.push('--format', `bv*${height}[ext=mp4]+ba[ext=m4a]/b${height}[ext=mp4]/bv*${height}+ba/b${height}`,
      '--merge-output-format', 'mp4/mkv');
  }
  args.push('--', job.url);
  return args;
}

// Older yt-dlp builds can emit bare NA even with JSON conversions. Replace only
// bare missing-value tokens outside JSON strings; never use eval or alter titles.
function parseEngineJson(text) {
  let normalized = '';
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      normalized += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
      normalized += char;
    } else if (text.startsWith('NA', i) && /[\s,}\]]|^$/.test(text[i + 2] || '') && /[[:,]$/.test(normalized.trimEnd())) {
      normalized += 'null';
      i++;
    } else normalized += char;
  }
  return JSON.parse(normalized);
}

function validUploadDate(value) {
  if (typeof value !== 'string' || !/^\d{8}$/.test(value)) return '';
  const date = new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10).replace(/-/g, '') === value ? value : '';
}

function humanizeError(diagnostic, code) {
  const s = String(diagnostic || '');
  if (/非媒体内容/.test(s)) return '服务器返回了非媒体内容，可能受到网络或平台限制；请移走该错误下载文件后重试';
  if (/ENOENT|not found|No such file/i.test(s) && /ffmpeg|ffprobe|yt-dlp|ENOENT/i.test(s)) return '下载引擎缺失，请重新解压完整安装包后重试';
  if (/ENOSPC|No space left|disk full/i.test(s)) return '磁盘空间不足，请清理空间或更换下载文件夹';
  if (/EACCES|EPERM|Permission denied|Access is denied/i.test(s)) return '无法写入下载文件夹，请选择有写入权限的位置';
  if (/DRM|digital rights/i.test(s)) return '该视频受 DRM 保护，无法下载';
  if (/429|Too Many Requests|rate.limit/i.test(s)) return '平台暂时限制请求，请稍后重试或降低并发数';
  if (/Sign in|login|log in|cookies|members.only|subscriber.only|private video|age.restrict|not a bot|authentication/i.test(s)) return '该视频需要登录、会员权限或平台验证；本工具不读取登录凭据，请改用公开可下载的视频';
  if (/Requested format is not available|no video formats|format.*not available/i.test(s)) return '此视频没有所选画质的可下载格式，请尝试其他画质';
  if (/(?:HTTP(?: Error)?|status(?: code)?)[ :]+5\d\d\b|Service Unavailable/i.test(s)) return '平台服务暂时不可用（服务器错误），请稍后重试';
  if (/copyright|removed|deleted|unavailable|not available|404|does not exist/i.test(s)) return '视频不存在、已下架，或在当前地区不可用';
  if (/is_live|live.*filter|does not pass filter|livestream/i.test(s)) return '暂不录制正在直播的内容，请使用已结束的回放或剪辑';
  if (/timed? ?out|ETIMEDOUT|timeout|超时/i.test(s)) return '下载长时间没有响应或已超时，请检查网络后重试';
  if (/403|forbidden|412|precondition/i.test(s)) return '平台拒绝了本次访问，请稍后重试；部分视频可能受地区或平台限制';
  if (/certificate|SSL|TLS/i.test(s)) return '安全连接校验失败，请检查系统时间和网络；工具不会跳过证书验证';
  if (/network|connection|resolve|ENOTFOUND|ECONNRESET|urlopen/i.test(s)) return '网络连接失败，请检查网络或代理设置后重试';
  if (/ffmpeg|ffprobe|Postprocessing/i.test(s)) return '合并或音频转换失败，请查看诊断并检查下载文件夹空间';
  return `下载失败${code == null ? '' : `（代码 ${code}）`}，可查看诊断信息后重试`;
}

function isClearlyNonMedia(prefix) {
  // Reject recognizable server error documents, not unknown media signatures.
  // MP4, WebM/MKV, MP3 and transport streams do not start with these text forms.
  const text = prefix.toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (/^(?:<!--[\s\S]*?-->\s*)*<(?:!doctype\s+html|html\b|head\b|body\b)/i.test(text)) return true;
  if (/^(?:<\?xml[^>]*>\s*)?<Error(?:\s|>)/i.test(text)) return true;
  if (/^\{\s*"/.test(text) || /^\[\s*(?:\{|\[|")/.test(text)) return true;
  return false;
}

function withinDirectory(file, directory) {
  const relative = path.relative(path.resolve(directory), path.resolve(file));
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

// Windows taskkill /T also terminates ffmpeg and the bundled JavaScript runtime.
// POSIX children are session leaders, so a negative pid targets the entire group.
async function terminateProcessTree(child, { platform = process.platform, spawnFn = spawn, graceMs = 2000 } = {}) {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0) return;
  if (platform === 'win32') {
    const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    await new Promise((resolve, reject) => {
      let killer;
      let done = false;
      const finish = err => { if (done) return; done = true; clearTimeout(timer); err ? reject(err) : resolve(); };
      const timer = setTimeout(() => { killer?.kill(); finish(new Error('终止进程树超时')); }, 10000);
      try {
        killer = spawnFn(executable, ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        killer.once('error', finish);
        killer.once('close', code => finish(code === 0 || child.exitCode != null || child.signalCode ? null : new Error(`taskkill 退出代码 ${code}`)));
      } catch (err) { finish(err); }
    });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (err) { if (err.code !== 'ESRCH') throw err; }
    await new Promise(resolve => setTimeout(resolve, graceMs));
    try { process.kill(-child.pid, 'SIGKILL'); } catch (err) { if (err.code !== 'ESRCH') throw err; }
  }
}

class QueueManager extends EventEmitter {
  constructor({ statePath, defaultOutputDir, binaries, spawnFn = spawn, terminateFn = terminateProcessTree, idleTimeoutMs = 5 * 60 * 1000, jobTimeoutMs = 12 * 60 * 60 * 1000, stopTimeoutMs = 15000 } = {}) {
    super();
    if (!statePath || !path.isAbsolute(statePath)) throw new Error('statePath 必须是绝对路径');
    this.statePath = statePath;
    this.binaries = { ...binaries };
    this.spawnFn = spawnFn;
    this.terminateFn = terminateFn;
    this.idleTimeoutMs = idleTimeoutMs;
    this.jobTimeoutMs = jobTimeoutMs;
    this.stopTimeoutMs = stopTimeoutMs;
    this.settings = validateSettings({ outputDir: defaultOutputDir, quality: 'best', concurrency: 2 }, {});
    this.jobs = [];
    this.history = new Map();
    this._knownUrls = new Set();
    this._jobsByDownload = new Map();
    this.paused = true;
    this.engine = { ready: false, missing: [], error: '', persistenceError: '', updating: false };
    this._engineUpdating = false;
    this._engineStopUncertain = false;
    this._active = new Map();
    this._saveChain = Promise.resolve();
    this._saveTimer = null;
    this._initialized = false;
    this._closed = false;
    this._initPromise = null;
    this._shutdownPromise = null;
  }

  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._initialize();
    return this._initPromise;
  }

  async _initialize() {
    try {
      const stat = await fsp.stat(this.statePath);
      if (stat.size > 512 * 1024 * 1024) throw new Error('队列文件过大');
      const data = JSON.parse(await fsp.readFile(this.statePath, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.jobs)) throw new Error('队列文件格式不正确');
      if (data.jobs.length > MAX_JOBS) throw new Error(`队列超过 ${MAX_JOBS} 条，原文件已保留`);
      try { this.settings = validateSettings(data.settings || {}, this.settings); } catch { /* Keep safe defaults. */ }
      const seen = new Set();
      for (const saved of data.jobs.slice(0, MAX_JOBS)) {
        try {
          const normalized = normalizeUrl(saved.url);
          if (typeof saved.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(saved.id)) continue;
          const settings = validateSettings({ quality: saved.quality || this.settings.quality, outputDir: saved.outputDir || this.settings.outputDir }, this.settings);
          const key = this._historyKey({ ...normalized, ...settings });
          if (seen.has(key)) continue;
          const status = ACTIVE.has(saved.status) || saved.status === 'queued' ? 'paused' : STATUSES.has(saved.status) ? saved.status : 'paused';
          seen.add(key);
          this.jobs.push({
            id: saved.id, ...normalized, title: String(saved.title || normalized.url).slice(0, 500), status,
            quality: settings.quality, outputDir: settings.outputDir,
            namingVersion: saved.namingVersion === 2 ? 2 : 1,
            uploadDate: validUploadDate(saved.uploadDate),
            channelId: typeof saved.channelId === 'string' ? saved.channelId.slice(0, 160) : '',
            progress: Number.isFinite(saved.progress) ? Math.max(0, Math.min(100, saved.progress)) : 0,
            speed: 0, eta: null,
            error: typeof saved.error === 'string' ? saved.error.slice(0, 1000) : '',
            diagnostic: typeof saved.diagnostic === 'string' ? saved.diagnostic.slice(-MAX_LOG) : '',
            outputPath: typeof saved.outputPath === 'string' && withinDirectory(saved.outputPath, settings.outputDir) ? saved.outputPath : '',
            createdAt: typeof saved.createdAt === 'string' ? saved.createdAt.slice(0, 40) : new Date().toISOString(),
            updatedAt: new Date().toISOString(), attempts: Number.isInteger(saved.attempts) ? Math.min(10000, Math.max(0, saved.attempts)) : 0
          });
        } catch { /* Invalid entries cannot become executable tasks. */ }
      }
      // Completion history survives clearing queue records. Only paths inside the
      // recorded destination may be reused, and import checks the file still exists.
      for (const saved of Array.isArray(data.history) ? data.history : []) {
        try {
          const normalized = normalizeUrl(saved.url);
          const settings = validateSettings({ quality: saved.quality, outputDir: saved.outputDir }, this.settings);
          if (typeof saved.outputPath !== 'string' || !withinDirectory(saved.outputPath, settings.outputDir)) continue;
          const record = { ...normalized, quality: settings.quality, outputDir: settings.outputDir, outputPath: saved.outputPath };
          this.history.set(this._historyKey(record), record);
        } catch { /* Untrusted saved records never become executable tasks. */ }
      }
      for (const job of this.jobs) if (job.status === 'completed' && job.outputPath) this._remember(job);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.engine.persistenceError = `未能读取上次队列：${err.message}`;
        // Preserve a damaged state file for recovery instead of silently destroying it.
        try { await fsp.rename(this.statePath, `${this.statePath}.corrupt-${Date.now()}`); } catch { /* Reported above. */ }
      }
    }
    for (const key of ['ytDlp', 'ffmpeg']) {
      try {
        if (!this.binaries[key] || !path.isAbsolute(this.binaries[key])) throw new Error('missing');
        await fsp.access(this.binaries[key], fs.constants.R_OK);
      } catch { this.engine.missing.push(key); }
    }
    if (this.binaries.jsRuntime) {
      try { await fsp.access(this.binaries.jsRuntime, fs.constants.R_OK); } catch { this.engine.missing.push('jsRuntime'); }
    }
    this.engine.ready = this.engine.missing.length === 0;
    this._knownUrls = new Set(this.jobs.map(job => job.url));
    this._jobsByDownload = new Map(this.jobs.map(job => [this._historyKey(job), job]));
    if (!this.engine.ready) this.engine.error = `下载引擎缺失：${this.engine.missing.join('、')}，请重新解压完整安装包`;
    this._initialized = true;
    await this._persist();
    this._changed(false);
    return this.snapshot();
  }

  snapshot(view = { page: 1, filter: 'all' }) {
    let jobs = this.jobs;
    let queue;
    if (view) {
      const counts = { completed: 0, active: 0, waiting: 0, failed: 0 };
      let hasFinished = false, hasQueued = false;
      const filter = ['all', 'active', 'completed', 'failed'].includes(view.filter) ? view.filter : 'all';
      const filtered = [];
      for (const job of this.jobs) {
        if (job.status === 'completed') counts.completed++;
        if (ACTIVE.has(job.status)) counts.active++;
        if (['queued', 'paused'].includes(job.status)) counts.waiting++;
        if (job.status === 'failed') counts.failed++;
        if (FINISHED.has(job.status)) hasFinished = true;
        if (job.status === 'queued') hasQueued = true;
        if (filter === 'all' || (filter === 'active' ? ACTIVE.has(job.status) : job.status === filter)) filtered.push(job);
      }
      const pageSize = 50;
      const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
      const page = Math.min(pages, Math.max(1, Number.isSafeInteger(view.page) ? view.page : 1));
      jobs = filtered.slice((page - 1) * pageSize, page * pageSize);
      queue = { total: this.jobs.length, filteredTotal: filtered.length, page, pages, pageSize, counts, hasFinished, hasQueued, filter };
    }
    return JSON.parse(JSON.stringify({ settings: this.settings, jobs, paused: this.paused, engine: this.engine, ...(queue ? { queue } : {}) }));
  }

  _historyKey(job) {
    let directory = path.resolve(job.outputDir);
    if (process.platform === 'win32') directory = directory.toLowerCase();
    return JSON.stringify([job.url, job.quality, directory]);
  }

  _remember(job) {
    this.history.set(this._historyKey(job), { url: job.url, quality: job.quality, outputDir: job.outputDir, outputPath: job.outputPath });
  }

  async wasDownloaded(url, settings) {
    const record = this.history.get(this._historyKey({ url, ...settings }));
    if (!record) return false;
    try { const stat = await fsp.stat(record.outputPath); return stat.isFile() && stat.size > 0; }
    catch { return false; }
  }

  // Channel discovery imports in bounded batches without the single-video text
  // input limit. The downloader still receives exactly one validated video URL.
  addChannelBatch(entries, settings, channelId) {
    this._assertReady();
    this._assertEngineNotUpdating();
    const selected = validateSettings(settings, this.settings);
    if (!Array.isArray(entries) || entries.length > 100) throw new Error('频道每批最多添加 100 个视频');
    const candidates = [];
    const seen = new Set();
    let duplicates = 0;
    for (const entry of entries) {
      const value = normalizeUrl(entry.url);
      if (value.platform !== 'YouTube') throw new Error('频道仅支持 YouTube 视频');
      const key = this._historyKey({ ...value, ...selected });
      const existing = this._jobsByDownload.get(key);
      // The importer already checked the successful-file history. A completed
      // record reaching this method therefore needs its missing file restored.
      if ((existing && existing.status !== 'completed') || seen.has(key)) { duplicates++; continue; }
      seen.add(key);
      candidates.push({ ...value, title: String(entry.title || value.url).slice(0, 500), existing, key });
    }
    if (this.jobs.length + candidates.filter(item => !item.existing).length > MAX_JOBS) throw new Error(`队列最多保留 ${MAX_JOBS} 条，请清理已结束记录后再次导入；扫描结果已保留`);
    const now = new Date().toISOString();
    for (const item of candidates) {
      const { existing, key, ...video } = item;
      const job = { id: existing?.id || randomUUID(), ...video, channelId: String(channelId || '').slice(0, 160), status: this.paused ? 'paused' : 'queued',
        namingVersion: 2, uploadDate: '',
        quality: selected.quality, outputDir: selected.outputDir, progress: 0, speed: 0, eta: null,
        error: '', diagnostic: '', outputPath: '', createdAt: now, updatedAt: now, attempts: 0 };
      if (existing) Object.assign(existing, job);
      else this.jobs.push(job);
      this._jobsByDownload.set(key, existing || job);
      this._knownUrls.add(item.url);
    }
    this._changed();
    return { added: candidates.length, duplicates };
  }

  _assertReady() {
    if (!this._initialized) throw new Error('队列尚未初始化');
    if (this._closed) throw new Error('下载器正在退出');
  }

  _assertEngineNotUpdating() {
    if (this._engineUpdating) {
      const error = new Error('下载引擎正在更新，请等待更新结束后再开始或重试下载');
      error.code = 'ENGINE_BUSY';
      throw error;
    }
  }

  // This lease is acquired synchronously, before an updater performs any await.
  // _active includes _run records still preparing directories before spawn.
  acquireEngineUpdate() {
    this._assertReady();
    this._assertEngineNotUpdating();
    if (this._engineStopUncertain || (this.engine.error && !this.engine.ready && !this.engine.missing.length)) {
      const error = new Error('无法确认下载进程已经完全停止，请退出软件并确认进程已结束后重开，再更新下载引擎');
      error.code = 'ENGINE_BUSY';
      throw error;
    }
    if (this._active.size || (!this.paused && this.jobs.some(job => job.status === 'queued'))) {
      const error = new Error('下载任务正在运行或即将开始，请先暂停队列并等待下载进程完全停止后再更新');
      error.code = 'ENGINE_BUSY';
      throw error;
    }
    this._engineUpdating = true;
    this.engine.updating = true;
    this._changed(false);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this._engineUpdating = false;
      this.engine.updating = false;
      this._changed(false);
      // _pump also observes any pause, shutdown, or new lease taken by listeners.
      this._pump();
    };
  }

  updateSettings(next) {
    this._assertReady();
    this.settings = validateSettings(next, this.settings);
    this._changed();
    this._pump();
    return this.snapshot();
  }

  add(text, settings) {
    this._assertReady();
    const selected = settings ? validateSettings(settings, this.settings) : this.settings;
    const parsed = parseUrls(text, this.jobs);
    if (this.jobs.length + parsed.added.length > MAX_JOBS) throw new Error(`队列最多保留 ${MAX_JOBS} 个任务，请先清理已结束的任务`);
    if (settings) this.settings = selected;
    const now = new Date().toISOString();
    const added = parsed.added.map(item => ({
      id: randomUUID(), ...item, title: item.url, status: 'queued',
      namingVersion: 2, uploadDate: '',
      quality: selected.quality, outputDir: selected.outputDir, progress: 0, speed: 0, eta: null,
      error: '', diagnostic: '', outputPath: '', createdAt: now, updatedAt: now, attempts: 0
    }));
    this.jobs.push(...added);
    for (const job of added) { this._knownUrls.add(job.url); this._jobsByDownload.set(this._historyKey(job), job); }
    this._changed();
    this._pump();
    return { added: JSON.parse(JSON.stringify(added)), duplicates: parsed.duplicates, errors: parsed.errors };
  }

  start() {
    this._assertReady();
    this._assertEngineNotUpdating();
    if (!this.engine.ready) throw new Error(this.engine.error);
    if ([...this._active.values()].some(record => record.stopReason)) throw new Error('正在停止下载进程，请稍后再开始');
    this.paused = false;
    for (const job of this.jobs) if (job.status === 'paused') job.status = 'queued';
    this._changed();
    this._pump();
    return this.snapshot();
  }

  startSelected(entries, settings) {
    this._assertReady();
    this._assertEngineNotUpdating();
    if (!this.engine.ready) throw new Error(this.engine.error);
    if (!Array.isArray(entries) || !entries.length || entries.length > MAX_JOBS) throw new Error('请选择 1 到 100,000 个视频');
    const selected = validateSettings(settings, this.settings);
    const keys = new Set(entries.map(entry => this._historyKey({ ...normalizeUrl(entry?.url), ...selected })));
    const eligible = [...keys].map(key => this._jobsByDownload.get(key)).filter(job => job && ['queued', 'paused'].includes(job.status) && !this._active.has(job.id));
    if (!eligible.length) return 0;
    if ([...this._active.values()].some(record => record.stopReason)) throw new Error('正在停止下载进程，请稍后再开始');
    // Starting selected channel videos must not resume unrelated work from a
    // paused queue. Already-running queues keep their existing scheduled work.
    if (this.paused) for (const job of this.jobs) if (job.status === 'queued') job.status = 'paused';
    for (const job of eligible) job.status = 'queued';
    this.paused = false;
    this._changed();
    this._pump();
    return eligible.length;
  }

  async pause() {
    this._assertReady();
    this.paused = true;
    for (const job of this.jobs) if (job.status === 'queued') job.status = 'paused';
    const stops = [...this._active.values()].map(record => this._stop(record, 'paused'));
    this._changed();
    await Promise.all(stops);
    await this._persist();
    return this.snapshot();
  }

  async cancel(id) {
    this._assertReady();
    const job = this._job(id);
    const active = this._active.get(id);
    if (active) await this._stop(active, 'cancelled');
    else if (!FINISHED.has(job.status)) { job.status = 'cancelled'; job.speed = 0; job.eta = null; job.updatedAt = new Date().toISOString(); this._changed(); }
    return this.snapshot();
  }

  retry(id) {
    this._assertReady();
    this._assertEngineNotUpdating();
    const job = this._job(id);
    if (this._active.has(id)) throw new Error('请先暂停或取消正在运行的任务');
    if (!['failed', 'cancelled', 'paused'].includes(job.status)) throw new Error('仅可重试失败、取消或暂停的任务');
    Object.assign(job, { status: 'queued', progress: 0, speed: 0, eta: null, error: '', diagnostic: '', outputPath: '', updatedAt: new Date().toISOString() });
    this._changed();
    this._pump();
    return this.snapshot();
  }

  remove(id) {
    this._assertReady();
    this._job(id);
    if (this._active.has(id)) throw new Error('请先暂停或取消正在运行的任务');
    this.jobs = this.jobs.filter(j => j.id !== id);
    this._knownUrls = new Set(this.jobs.map(job => job.url));
    this._jobsByDownload = new Map(this.jobs.map(job => [this._historyKey(job), job]));
    this._changed();
    return this.snapshot();
  }

  clearFinished() {
    this._assertReady();
    this.jobs = this.jobs.filter(j => !FINISHED.has(j.status) || this._active.has(j.id));
    this._knownUrls = new Set(this.jobs.map(job => job.url));
    this._jobsByDownload = new Map(this.jobs.map(job => [this._historyKey(job), job]));
    this._changed();
    return this.snapshot();
  }

  _job(id) {
    const job = this.jobs.find(j => j.id === id);
    if (!job) throw new Error('找不到该下载任务');
    return job;
  }

  _pump() {
    if (this.paused || this._closed || this._engineUpdating || !this.engine.ready) return;
    while (!this.paused && !this._closed && !this._engineUpdating && this.engine.ready && this._active.size < this.settings.concurrency) {
      const job = this.jobs.find(j => j.status === 'queued' && !this._active.has(j.id));
      if (!job) break;
      const record = { job, child: null, stopReason: '', diagnostic: '', finished: false, timers: [], stopPromise: null };
      record.done = new Promise(resolve => { record.resolve = resolve; });
      this._active.set(job.id, record);
      Object.assign(job, { status: 'downloading', progress: 0, speed: 0, eta: null, error: '', diagnostic: '', outputPath: '', attempts: job.attempts + 1, updatedAt: new Date().toISOString() });
      this._changed();
      void this._run(record);
    }
  }

  async _run(record) {
    const { job } = record;
    try {
      await fsp.mkdir(job.outputDir, { recursive: true });
      await fsp.access(job.outputDir, fs.constants.W_OK);
      if (record.stopReason || this._closed) return this._finish(record, null);
      const child = this.spawnFn(this.binaries.ytDlp, buildArgs(job, this.binaries), {
        shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
      });
      record.child = child;
      const touch = () => {
        clearTimeout(record.idleTimer);
        record.idleTimer = setTimeout(() => {
          this._appendLog(record, '下载长时间没有进度，已超时停止');
          void this._stop(record, 'timeout');
        }, this.idleTimeoutMs);
      };
      record.timers.push(setTimeout(() => {
        this._appendLog(record, '下载达到最长运行时间，已超时停止');
        void this._stop(record, 'timeout');
      }, this.jobTimeoutMs));
      touch();
      const attach = (stream, stderr) => {
        if (!stream) return;
        const decoder = new StringDecoder('utf8');
        let buffer = '';
        stream.on('data', chunk => {
          touch();
          buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          let index;
          while ((index = buffer.indexOf('\n')) !== -1) {
            this._line(record, buffer.slice(0, index).replace(/\r$/, ''), stderr);
            buffer = buffer.slice(index + 1);
          }
          if (buffer.length > 65536) { this._appendLog(record, buffer.slice(-MAX_LOG)); buffer = ''; }
        });
        stream.on('end', () => {
          buffer += decoder.end();
          if (buffer) this._line(record, buffer.replace(/\r$/, ''), stderr);
        });
      };
      attach(child.stdout, false);
      attach(child.stderr, true);
      child.once('error', err => { this._appendLog(record, `${err.code || ''} ${err.message}`); void this._finish(record, -1); });
      child.once('close', (code, signal) => {
        if (signal) this._appendLog(record, `进程信号：${signal}`);
        void this._finish(record, code);
      });
    } catch (err) {
      this._appendLog(record, `${err.code || ''} ${err.message}`);
      await this._finish(record, -1);
    }
  }

  _appendLog(record, message) {
    // Signed CDN query strings are not needed for diagnostics and must not be saved.
    const safe = String(message)
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/(https?:\/\/[^\s?]+)\?[^\s]*/g, '$1?[参数已隐藏]')
      .replace(/(?:authorization|set-cookie|cookie)\s*:\s*[^\r\n]+/gi, '[认证信息已隐藏]')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
    record.diagnostic = `${record.diagnostic}${safe}\n`.slice(-MAX_LOG);
  }

  _line(record, line, stderr) {
    if (record.finished || record.stopReason) return;
    const { job } = record;
    try {
      if (line.startsWith('__META__')) {
        const value = parseEngineJson(line.slice(8));
        if (typeof value.title === 'string') job.title = value.title.slice(0, 500);
        job.uploadDate = validUploadDate(value.upload_date) || validUploadDate(value.release_date);
      } else if (line.startsWith('__PROGRESS__')) {
        const value = parseEngineJson(line.slice(12));
        const downloaded = Number(value.downloaded);
        const total = Number(value.total) || Number(value.estimate);
        if (Number.isFinite(total) && total > 0 && Number.isFinite(downloaded) && downloaded >= 0) job.progress = Math.min(99.9, Math.max(0, downloaded / total * 100));
        job.speed = Number.isFinite(value.speed) ? Math.max(0, value.speed) : 0;
        job.eta = Number.isFinite(value.eta) ? Math.max(0, value.eta) : null;
        job.status = 'downloading';
        if (value.status === 'finished') { job.status = 'processing'; job.speed = 0; job.eta = null; }
      } else if (line.startsWith('__POSTPROCESS__')) {
        job.status = 'processing'; job.speed = 0; job.eta = null;
      } else if (line.startsWith('__FILE__')) {
        const file = parseEngineJson(line.slice(8));
        if (typeof file === 'string' && path.isAbsolute(file) && withinDirectory(file, job.outputDir)) job.outputPath = path.resolve(file);
        else this._appendLog(record, '引擎返回了无效的输出文件路径');
      } else {
        if (line.trim()) this._appendLog(record, line);
        return;
      }
      job.updatedAt = new Date().toISOString();
      this._changed();
    } catch { if (stderr || line) this._appendLog(record, line.slice(0, MAX_LOG)); }
  }

  async _stop(record, reason) {
    if (record.finished) return record.done;
    // A user cancellation can supersede an earlier pause, but cannot restart a stopping process.
    if (!record.stopReason || reason === 'cancelled') record.stopReason = reason;
    if (record.stopPromise) return record.stopPromise;
    record.stopPromise = (async () => {
      if (record.child) {
        let timer;
        try {
          await Promise.race([
            this.terminateFn(record.child),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('终止进程树超时')), this.stopTimeoutMs); })
          ]);
        } catch (err) {
          this._appendLog(record, `停止进程时出错：${err.message}`);
          this.paused = true;
          this._engineStopUncertain = true;
          this.engine.ready = false;
          this.engine.error = '无法确认下载进程树已完全停止，请退出程序并在任务管理器中检查 yt-dlp、ffmpeg 后重新打开';
          try { record.child.kill('SIGKILL'); } catch { /* Preserve diagnostic. */ }
        } finally { clearTimeout(timer); record.stopSettled = true; }
        if (!record.finished) await this._finish(record, null);
      } else {
        // _run checks this marker after directory creation and before spawning.
        await this._finish(record, null);
      }
      await record.done;
    })();
    return record.stopPromise;
  }

  async _finish(record, code) {
    if (record.finished) return;
    if (record.stopReason && record.child && !record.stopSettled) return;
    record.finished = true;
    clearTimeout(record.idleTimer);
    for (const timer of record.timers) clearTimeout(timer);
    const { job } = record;
    let hasFile = false;
    if (job.outputPath) {
      try {
        const stat = await fsp.stat(job.outputPath);
        hasFile = stat.isFile() && stat.size > 0;
        if (hasFile) {
          const handle = await fsp.open(job.outputPath, 'r');
          try {
            const buffer = Buffer.alloc(512);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            if (isClearlyNonMedia(buffer.subarray(0, bytesRead))) {
              hasFile = false;
              this._appendLog(record, '服务器返回了非媒体内容，可能受到网络或平台限制；错误响应文件已保留，未视为视频');
            }
          } finally { await handle.close(); }
        }
      } catch { hasFile = false; /* No completed readable file. */ }
    }
    if (record.stopReason === 'paused' || record.stopReason === 'cancelled') {
      job.status = record.stopReason;
      job.error = '';
    } else if (!record.stopReason && (code === 0 || code === 101) && hasFile) {
      job.status = 'completed'; job.progress = 100; job.error = '';
      this._remember(job);
    } else {
      job.status = 'failed';
      if (!record.diagnostic && !hasFile) this._appendLog(record, '引擎未生成可用文件；视频可能被过滤、不可用，或下载未完成');
      job.error = humanizeError(record.diagnostic, code);
      job.outputPath = '';
    }
    job.speed = 0;
    job.eta = null;
    job.diagnostic = record.diagnostic.slice(-MAX_LOG);
    job.updatedAt = new Date().toISOString();
    this._active.delete(job.id);
    this._changed();
    record.resolve();
    this._pump();
  }

  _changed(save = true) {
    if (save && !this._saveTimer) {
      this._saveTimer = setTimeout(() => { this._saveTimer = null; void this._persist(); }, 2000);
    }
    this.emit('change');
  }

  _persist() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    // Only allowlisted fields are saved, never engine environment or extracted media URLs.
    const payload = JSON.stringify({ version: 1, settings: this.settings, jobs: this.jobs.map(job => ({
      id: job.id, url: job.url, title: job.title, status: job.status, quality: job.quality,
      namingVersion: job.namingVersion, uploadDate: job.uploadDate || '',
      outputDir: job.outputDir, channelId: job.channelId || '', progress: job.progress, error: job.error, diagnostic: job.diagnostic.slice(-1024),
      outputPath: job.outputPath, createdAt: job.createdAt, updatedAt: job.updatedAt, attempts: job.attempts
    })), history: [...this.history.values()] });
    this._saveChain = this._saveChain.then(async () => {
      const temp = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await fsp.mkdir(path.dirname(this.statePath), { recursive: true });
        const handle = await fsp.open(temp, 'wx', 0o600);
        try { await handle.writeFile(payload, 'utf8'); await handle.sync(); } finally { await handle.close(); }
        // Windows indexers can briefly hold the destination; retry without unlinking it.
        for (let attempt = 0; ; attempt++) {
          try { await fsp.rename(temp, this.statePath); break; }
          catch (err) {
            if (attempt >= 3 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
            await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
          }
        }
        if (this.engine.persistenceError.startsWith('队列保存失败：')) {
          this.engine.persistenceError = '';
          this.emit('change');
        }
      } catch (err) {
        this.engine.persistenceError = `队列保存失败：${err.message}`;
        try { await fsp.unlink(temp); } catch { /* Best effort cleanup. */ }
        this.emit('change');
      }
    });
    return this._saveChain;
  }

  async shutdown() {
    if (!this._shutdownPromise) this._shutdownPromise = (async () => {
      if (!this._initialized) await this.init();
      this._closed = true;
      this.paused = true;
      for (const job of this.jobs) if (job.status === 'queued') job.status = 'paused';
      await Promise.all([...this._active.values()].map(record => this._stop(record, 'paused')));
      await this._persist();
    })();
    return this._shutdownPromise;
  }
}

module.exports = { QueueManager, normalizeUrl, parseUrls, buildArgs, validateSettings, humanizeError, terminateProcessTree, parseEngineJson, isClearlyNonMedia };
