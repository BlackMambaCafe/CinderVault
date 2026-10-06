'use strict';

// Only the public yt-dlp stable release is queried. No credentials, cookies,
// downloader configuration, shell, or third-party update service are used.
const { EventEmitter } = require('node:events');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { terminateProcessTree } = require('./core');

const LATEST_URL = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';
const RELEASE_PREFIX = 'https://github.com/yt-dlp/yt-dlp/releases/download/';
const REDIRECT_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com']);
const VERSION = /^\d{4}\.\d{2}\.\d{2}(?:\.\d{1,4})?$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_BINARY = 100 * 1024 * 1024;
const SUCCESS_TTL = 12 * 60 * 60 * 1000;
const FAILURE_TTL = 60 * 60 * 1000;

function fault(code, message) { return Object.assign(new Error(message), { code }); }
function validVersion(value) {
  if (typeof value !== 'string' || !VERSION.test(value)) return false;
  const [year, month, day] = value.split('.').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 2020 && year <= 2199 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function compareVersions(a, b) {
  const aa = a.split('.').map(Number), bb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    if ((aa[i] || 0) !== (bb[i] || 0)) return (aa[i] || 0) > (bb[i] || 0) ? 1 : -1;
  }
  return 0;
}
function approvedUrl(raw, redirect = false) {
  let url;
  try { url = new URL(raw); } catch { throw fault('BAD_SOURCE', '更新地址无效'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash) throw fault('BAD_SOURCE', '更新只允许官方 HTTPS 地址');
  if (!redirect) {
    if (url.href === LATEST_URL) return url;
    if (url.origin !== 'https://github.com' || !/^\/yt-dlp\/yt-dlp\/releases\/download\/\d{4}\.\d{2}\.\d{2}(?:\.\d{1,4})?\/(?:yt-dlp\.exe|SHA2-256SUMS)$/.test(url.pathname) || url.search) throw fault('BAD_SOURCE', '更新来源不是 yt-dlp 官方稳定发行');
  } else if (!REDIRECT_HOSTS.has(url.hostname)) throw fault('BAD_SOURCE', '官方更新重定向到了不受信任的地址');
  return url;
}

// Each request has a total deadline (including redirects), a body size limit,
// and the platform's normal TLS certificate checks. Returned body is a Buffer.
function requestOfficial(rawUrl, { signal, maxBytes = 2 * 1024 * 1024, timeoutMs = 20000, onProgress } = {}) {
  approvedUrl(rawUrl);
  return new Promise((resolve, reject) => {
    let request, response, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) { request?.destroy(); response?.destroy(); reject(error); }
      else resolve(value);
    };
    const onAbort = () => finish(fault('ABORT_ERR', '更新已取消，旧引擎保留'));
    const timer = setTimeout(() => finish(fault('ETIMEDOUT', '连接官方更新服务器超时')), timeoutMs);
    const follow = (url, depth = 0) => {
      try { approvedUrl(url, depth > 0); } catch (error) { finish(error); return; }
      if (depth > 5) { finish(fault('BAD_SOURCE', '官方更新重定向次数过多')); return; }
      request = https.get(url, { headers: { 'User-Agent': 'CinderVault/1.0.3', Accept: url === LATEST_URL ? 'application/vnd.github+json' : 'application/octet-stream' } }, res => {
        response = res;
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          if (!res.headers.location) { finish(fault('BAD_SOURCE', '官方服务器返回空重定向')); return; }
          let next;
          try { next = new URL(res.headers.location, url).href; } catch { finish(fault('BAD_SOURCE', '官方服务器返回无效重定向')); return; }
          follow(next, depth + 1);
          return;
        }
        if (res.statusCode !== 200) { res.resume(); finish(fault('HTTP_STATUS', `官方更新服务器返回 HTTP ${res.statusCode}`)); return; }
        const length = Number(res.headers['content-length']) || 0;
        if (length > maxBytes) { finish(fault('TOO_LARGE', '官方更新文件大小超出安全上限')); return; }
        const chunks = []; let received = 0;
        res.on('data', chunk => {
          received += chunk.length;
          if (received > maxBytes) { finish(fault('TOO_LARGE', '官方更新文件大小超出安全上限')); return; }
          chunks.push(chunk);
          onProgress?.(received, length);
        });
        res.on('aborted', () => finish(fault('DOWNLOAD_INTERRUPTED', '更新下载中断')));
        res.on('error', error => finish(error));
        res.on('end', () => {
          if (length && received !== length) finish(fault('DOWNLOAD_INTERRUPTED', '更新下载不完整'));
          else finish(null, Buffer.concat(chunks, received));
        });
      });
      request.on('error', error => finish(error));
    };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    follow(rawUrl);
  });
}

// The packaged app uses Chromium's Windows network stack, which honors the
// system's existing proxy routing. Every redirect is checked before following;
// cookies/HTTP credentials are omitted and no network settings are changed.
function createElectronRequest(net) {
  if (!net || typeof net.request !== 'function') throw new TypeError('Electron net.request is required');
  return function electronRequest(rawUrl, { signal, maxBytes = 2 * 1024 * 1024, timeoutMs = 20000, onProgress } = {}) {
    return new Promise((resolve, reject) => {
      approvedUrl(rawUrl);
      let request, settled = false, redirects = 0;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error) { request?.abort(); reject(error); }
        else resolve(value);
      };
      const networkError = error => finish(error?.code ? error : Object.assign(fault('NETWORK', '无法连接官方更新服务器或下载已中断，请检查网络后重试；旧版已保留。'), { cause: error }));
      const onAbort = () => finish(fault('ABORT_ERR', '更新已取消，旧引擎保留'));
      const timer = setTimeout(() => finish(fault('ETIMEDOUT', '连接官方更新服务器超时')), timeoutMs);
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        request = net.request({
          method: 'GET', url: rawUrl, redirect: 'manual', credentials: 'omit',
          useSessionCookies: false, cache: 'no-store', bypassCustomProtocolHandlers: true,
          headers: { 'User-Agent': 'CinderVault/1.0.3', Accept: rawUrl === LATEST_URL ? 'application/vnd.github+json' : 'application/octet-stream' },
        });
        request.on('redirect', (statusCode, method, redirectUrl) => {
          if (settled) return;
          try {
            if (++redirects > 5) throw fault('BAD_SOURCE', '官方更新重定向次数过多');
            if (method !== 'GET') throw fault('BAD_SOURCE', '官方更新返回不受支持的重定向方式');
            approvedUrl(redirectUrl, true);
            // Electron requires this call synchronously inside the event.
            request.followRedirect();
          } catch (error) { finish(error); }
        });
        request.on('login', (_authInfo, callback) => { callback(); finish(fault('NETWORK', '官方更新连接需要网络认证，未读取或发送任何账号凭据；请检查网络后重试。')); });
        request.on('error', networkError);
        request.on('abort', () => { if (!settled) finish(fault('DOWNLOAD_INTERRUPTED', '更新下载中断')); });
        // Chromium can emit request.close before response itself. Do not use
        // close as failure: error/abort/response end and the total deadline own
        // completion, including the no-response case.
        request.on('response', response => {
          if (settled) return;
          response.on('error', networkError);
          response.on('aborted', () => finish(fault('DOWNLOAD_INTERRUPTED', '更新下载中断')));
          if (response.statusCode !== 200) { finish(fault('HTTP_STATUS', `官方更新服务器返回 HTTP ${response.statusCode}`)); return; }
          const header = name => { const value = response.headers[name]; return Array.isArray(value) ? value[0] : value; };
          const length = Number(header('content-length')) || 0;
          // Chromium decodes compressed responses before exposing their stream.
          const expectedLength = header('content-encoding') ? 0 : length;
          if (length > maxBytes) { finish(fault('TOO_LARGE', '官方更新文件大小超出安全上限')); return; }
          const chunks = []; let received = 0;
          response.on('data', chunk => {
            if (settled) return;
            received += chunk.length;
            if (received > maxBytes) { finish(fault('TOO_LARGE', '官方更新文件大小超出安全上限')); return; }
            chunks.push(Buffer.from(chunk));
            onProgress?.(received, expectedLength);
          });
          response.on('end', () => {
            if (expectedLength && received !== expectedLength) finish(fault('DOWNLOAD_INTERRUPTED', '更新下载不完整'));
            else finish(null, Buffer.concat(chunks, received));
          });
        });
        request.end();
      } catch (error) { networkError(error); }
    });
  };
}

function releaseMetadata(raw) {
  if (!raw || raw.draft !== false || raw.prerelease !== false || !validVersion(raw.tag_name) || !Array.isArray(raw.assets)) throw fault('BAD_RELEASE', '官方稳定版信息格式不正确');
  const asset = name => {
    const matches = raw.assets.filter(item => item.name === name);
    if (matches.length !== 1) throw fault('BAD_RELEASE', `官方发行缺少唯一的 ${name}`);
    const item = matches[0];
    const expected = `${RELEASE_PREFIX}${raw.tag_name}/${name}`;
    if (item.browser_download_url !== expected) throw fault('BAD_SOURCE', '官方发行的下载地址校验失败');
    approvedUrl(expected);
    if (!Number.isSafeInteger(item.size) || item.size < 1 || item.size > (name === 'yt-dlp.exe' ? MAX_BINARY : 1024 * 1024)) throw fault('BAD_RELEASE', '官方发行文件大小不正确');
    if (item.digest != null && !/^sha256:[a-fA-F0-9]{64}$/.test(item.digest)) throw fault('BAD_RELEASE', '官方发行摘要格式不正确');
    return { url: expected, size: item.size, digest: item.digest?.slice(7).toLowerCase() || null };
  };
  return { version: raw.tag_name, binary: asset('yt-dlp.exe'), checksums: asset('SHA2-256SUMS') };
}
function validatedCachedRelease(value) {
  if (!value || !validVersion(value.version)) return null;
  try {
    return releaseMetadata({ tag_name: value.version, draft: false, prerelease: false, assets: [['yt-dlp.exe', value.binary], ['SHA2-256SUMS', value.checksums]].map(([name, a]) => ({ name, browser_download_url: a?.url, size: a?.size, digest: a?.digest ? `sha256:${a.digest}` : null })) });
  } catch { return null; }
}
function officialChecksum(buffer) {
  const matches = buffer.toString('utf8').split(/\r?\n/).map(line => line.match(/^([a-fA-F0-9]{64})[ \t]+\*?yt-dlp\.exe[ \t]*$/)).filter(Boolean);
  if (matches.length !== 1) throw fault('CHECKSUM', '官方 SHA256 清单缺少唯一的 yt-dlp.exe 摘要');
  return matches[0][1].toLowerCase();
}
function sha256(buffer) { return createHash('sha256').update(buffer).digest('hex'); }

function probeVersion(exePath, { signal, timeoutMs = 20000, spawnFn = spawn, terminateFn = terminateProcessTree } = {}) {
  return new Promise((resolve, reject) => {
    let child, output = '', errors = '', reason, stopping, stopDeadline;
    let finished = false;
    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(stopDeadline);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(output.trim());
    };
    const stop = error => {
      if (stopping || finished) return;
      reason = error;
      if (!child) { finish(error); return; }
      stopDeadline = setTimeout(() => {
        finish(Object.assign(fault('PROBE_STOP_FAILED', '无法确认引擎试运行进程已经停止，请退出烬匣并关闭占用进程后重开。'), { engineUnsafe: true }));
      }, 13000);
      // PyInstaller can have a bootloader child on Windows. Terminate the owned
      // tree, and wait for both taskkill and the process close event.
      stopping = Promise.resolve().then(() => terminateFn(child)).catch(() => {
        reason = Object.assign(fault('PROBE_STOP_FAILED', '无法确认引擎试运行进程已经停止，请退出烬匣并关闭占用进程后重开。'), { engineUnsafe: true });
        finish(reason);
      });
    };
    const onAbort = () => stop(fault('ABORT_ERR', '更新已取消，旧引擎保留'));
    const timer = setTimeout(() => stop(fault('ETIMEDOUT', '更新引擎试运行超时')), timeoutMs);
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    try { child = spawnFn(exePath, ['--ignore-config', '--no-plugin-dirs', '--version'], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { finish(error); return; }
    child.on('error', error => finish(error));
    child.stdout.on('data', chunk => { output += chunk.toString('utf8'); if (output.length > 8192) stop(fault('BAD_VERSION', '引擎试运行输出异常')); });
    child.stderr.on('data', chunk => { if (errors.length < 8192) errors += chunk.toString('utf8'); });
    child.on('close', async code => {
      if (stopping) await stopping;
      if (reason) finish(reason);
      else if (code !== 0 || !validVersion(output.trim())) finish(fault('BAD_VERSION', '引擎试运行失败或返回无效版本'));
      else finish();
    });
  });
}

function errorMessage(error) {
  switch (error?.code) {
    case 'ENGINE_BUSY': return '下载队列正在运行。请先暂停队列，并等待正在下载的项目结束或取消后再更新。';
    case 'EBUSY': case 'ETXTBSY': return '引擎文件正被占用，无法替换。请结束下载或关闭其他烬匣窗口后重试；旧版已保留。';
    case 'EACCES': case 'EPERM': return '没有写入权限，或 Windows 正在占用引擎。请关闭相关程序，或将完整文件夹移到可写位置后重试；旧版已保留。';
    case 'ENOSPC': return '磁盘空间不足，更新未完成；旧版已保留。';
    case 'ENOTFOUND': case 'EAI_AGAIN': case 'ENETUNREACH': case 'ECONNREFUSED': return '无法连接官方更新服务器，请检查网络后重试；当前引擎仍可使用。';
    case 'ECONNRESET': case 'DOWNLOAD_INTERRUPTED': return '更新下载中断，请重试；旧版已保留。';
    case 'ETIMEDOUT': return '官方更新检查或下载超时，请稍后重试；旧版已保留。';
    case 'ABORT_ERR': return '更新已取消，旧版已保留。';
    default: return String(error?.message || '更新失败，旧版已保留。').slice(0, 350);
  }
}

class EngineUpdater extends EventEmitter {
  constructor({ exePath, cachePath, acquireLock, deps = {} }) {
    super();
    if (!path.isAbsolute(exePath) || !path.isAbsolute(cachePath) || typeof acquireLock !== 'function') throw new TypeError('Updater requires absolute paths and an engine lock');
    this.exePath = exePath;
    this.cachePath = cachePath;
    this.journalPath = `${exePath}.update-journal.json`;
    this.acquireLock = acquireLock;
    this.io = deps.io || fs.promises;
    this.request = deps.request || requestOfficial;
    this.runVersion = deps.runVersion || probeVersion;
    this.now = deps.now || Date.now;
    this.release = null;
    this.lastCheckSuccess = false;
    this._closed = false;
    this._checkPromise = null;
    this._installPromise = null;
    this._controller = null;
    this._initPromise = null;
    this.state = { installedVersion: '', latestVersion: '', status: 'idle', message: '尚未检查更新', progress: 0, checkedAt: null, canUpdate: false, busy: false, engineReady: true };
  }
  snapshot() { return { ...this.state }; }
  _set(values) { Object.assign(this.state, values); this.emit('change', this.snapshot()); return this.snapshot(); }
  _available() { return !!this.release && !!this.state.installedVersion && compareVersions(this.release.version, this.state.installedVersion) > 0; }
  async _syncFile(file) { const handle = await this.io.open(file, 'r+'); try { await handle.sync(); } finally { await handle.close(); } }
  async _atomicJson(file, value) {
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await this.io.writeFile(temp, JSON.stringify(value), { flag: 'wx' });
      await this._syncFile(temp);
      await this.io.rename(temp, file);
    } finally { await this.io.unlink(temp).catch(() => {}); }
  }
  async _saveCache() {
    try {
      await this.io.mkdir(path.dirname(this.cachePath), { recursive: true });
      await this._atomicJson(this.cachePath, { schema: 1, checkedAt: this.state.checkedAt, success: this.lastCheckSuccess, release: this.release });
    } catch { /* A read-only profile must not prevent normal downloads. */ }
  }
  init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._initialize();
    return this._initPromise;
  }
  async _initialize() {
    try {
      await this._recover();
      this.state.installedVersion = await this.runVersion(this.exePath);
      if (!validVersion(this.state.installedVersion)) throw fault('BAD_VERSION', '已安装引擎无法正确返回版本');
    } catch (error) { return this._set({ status: 'error', message: `引擎初始化失败：${errorMessage(error)}`, engineReady: false, canUpdate: false }); }
    try {
      const cache = JSON.parse(await this.io.readFile(this.cachePath, 'utf8'));
      if (cache.schema === 1 && Number.isFinite(cache.checkedAt) && cache.checkedAt <= this.now() && cache.checkedAt > 0) {
        this.release = validatedCachedRelease(cache.release);
        this.lastCheckSuccess = cache.success === true && !!this.release;
        this.state.checkedAt = cache.checkedAt;
        this.state.latestVersion = this.release?.version || '';
        if (this.lastCheckSuccess) this._set({ status: this._available() ? 'available' : 'current', canUpdate: this._available(), message: this._available() ? '发现官方稳定版更新（上次检查结果）' : '当前引擎已是最新稳定版（上次检查结果）' });
        else this._set({ status: 'error', message: '上次未能连接官方更新服务器，可手动重试。', canUpdate: this._available() });
      }
    } catch { /* No valid cache: a background check can run immediately. */ }
    return this._set({});
  }
  check({ force = false } = {}) {
    if (this._closed) return Promise.resolve(this.snapshot());
    if (this._installPromise) return this._installPromise;
    if (this._checkPromise) return this._checkPromise;
    if (!force && this.state.checkedAt && this.now() - this.state.checkedAt < (this.lastCheckSuccess ? SUCCESS_TTL : FAILURE_TTL)) return Promise.resolve(this.snapshot());
    this._checkPromise = this._check().finally(() => { this._checkPromise = null; });
    return this._checkPromise;
  }
  async _fetchRelease(signal) {
    const data = await this.request(LATEST_URL, { signal, maxBytes: 2 * 1024 * 1024, timeoutMs: 20000 });
    let raw;
    try { raw = JSON.parse(data.toString('utf8')); } catch { throw fault('BAD_RELEASE', '官方稳定版信息无法读取'); }
    return releaseMetadata(raw);
  }
  async _check() {
    const controller = new AbortController(); this._controller = controller;
    this._set({ busy: true, status: 'checking', message: '正在检查 yt-dlp 官方稳定版…', progress: 0, canUpdate: false });
    try {
      this.release = await this._fetchRelease(controller.signal);
      this.lastCheckSuccess = true;
      this._set({ checkedAt: this.now(), latestVersion: this.release.version, status: this._available() ? 'available' : 'current', message: this._available() ? '有新的官方稳定版可更新' : (this.state.installedVersion === this.release.version ? '已是最新官方稳定版' : '当前引擎版本不低于官方稳定版') });
    } catch (error) {
      this.lastCheckSuccess = false;
      this._set({ checkedAt: this.now(), status: 'error', message: errorMessage(error) });
    } finally {
      await this._saveCache();
      if (this._controller === controller) this._controller = null;
      this._set({ busy: false, canUpdate: this.state.engineReady && this._available() });
    }
    return this.snapshot();
  }
  install() {
    if (this._closed || !this.state.engineReady) return Promise.resolve(this.snapshot());
    if (this._installPromise) return this._installPromise;
    let releaseLock;
    // Lock is acquired synchronously before any await: the queue cannot start
    // a job between the idle check and the update's first network operation.
    try { releaseLock = this.acquireLock(); if (typeof releaseLock !== 'function') throw fault('ENGINE_BUSY', '引擎锁不可用'); }
    catch (error) { return Promise.resolve(this._set({ status: 'error', message: errorMessage(error), canUpdate: this._available() })); }
    const runningCheck = this._checkPromise;
    this._installPromise = this._install(runningCheck).finally(() => { releaseLock(); this._installPromise = null; });
    return this._installPromise;
  }
  async _install(runningCheck) {
    if (runningCheck) await runningCheck;
    if (this._closed) return this.snapshot();
    const controller = new AbortController(); this._controller = controller;
    const token = randomUUID();
    const stage = path.join(path.dirname(this.exePath), `.yt-dlp-${token}.pending.exe`);
    const backup = path.join(path.dirname(this.exePath), `.yt-dlp-${token}.backup.exe`);
    let journal = null, replaced = false, finalized = false, releaseConfirmed = false;
    this._set({ busy: true, status: 'checking', progress: 0, message: '正在确认官方稳定版…', canUpdate: false });
    try {
      this.release = await this._fetchRelease(controller.signal);
      releaseConfirmed = true;
      this.lastCheckSuccess = true;
      this._set({ latestVersion: this.release.version, checkedAt: this.now() });
      if (!this._available()) this._set({ status: 'current', message: '当前引擎已是最新官方稳定版，无需更新。' });
      else {
      this._set({ status: 'downloading', message: '正在从 yt-dlp 官方发行下载更新…' });
      const sums = await this.request(this.release.checksums.url, { signal: controller.signal, maxBytes: 1024 * 1024, timeoutMs: 30000 });
      if (sums.length !== this.release.checksums.size || (this.release.checksums.digest && sha256(sums) !== this.release.checksums.digest)) throw fault('CHECKSUM', '官方校验清单大小或摘要不一致，更新已停止；旧版已保留。');
      const expectedHash = officialChecksum(sums);
      if (this.release.binary.digest && expectedHash !== this.release.binary.digest) throw fault('CHECKSUM', '官方发行摘要与 SHA256 清单不一致，更新已停止；旧版已保留。');
      const binary = await this.request(this.release.binary.url, { signal: controller.signal, maxBytes: MAX_BINARY, timeoutMs: 180000, onProgress: received => {
        const progress = Math.min(98, Math.floor(received / this.release.binary.size * 100));
        if (progress !== this.state.progress) this._set({ progress });
      } });
      if (controller.signal.aborted) throw fault('ABORT_ERR', '更新已取消');
      this._set({ status: 'verifying', message: '正在校验 SHA256 与新引擎版本…', progress: 99 });
      if (binary.length !== this.release.binary.size || sha256(binary) !== expectedHash) throw fault('CHECKSUM', '下载文件未通过官方 SHA256 完整性校验，更新已停止；旧版已保留。');
      await this.io.writeFile(stage, binary, { flag: 'wx', mode: 0o700 });
      await this._syncFile(stage);
      if (await this.runVersion(stage, { signal: controller.signal }) !== this.release.version) throw fault('BAD_VERSION', '新引擎版本与官方发行不一致，更新已停止；旧版已保留。');
      if (controller.signal.aborted) throw fault('ABORT_ERR', '更新已取消');
      const oldVersion = await this.runVersion(this.exePath, { signal: controller.signal });
      if (oldVersion !== this.state.installedVersion) throw fault('ENGINE_CHANGED', '当前引擎已被其他程序更改，请重启烬匣后再更新。');
      const oldHash = sha256(await this.io.readFile(this.exePath));
      await this.io.copyFile(this.exePath, backup, fs.constants.COPYFILE_EXCL);
      await this._syncFile(backup);
      if (sha256(await this.io.readFile(backup)) !== oldHash) throw fault('BACKUP', '旧引擎备份校验失败，更新已停止。');
      journal = { schema: 1, stage: path.basename(stage), backup: path.basename(backup), oldVersion, newVersion: this.release.version, oldHash, newHash: expectedHash };
      await this._atomicJson(this.journalPath, journal);
      if (controller.signal.aborted) throw fault('ABORT_ERR', '更新已取消');
      this._set({ status: 'installing', message: '正在安全替换引擎并保留旧版备份…' });
      // Same-directory rename uses atomic replacement. Never delete the current
      // executable first, even when Windows denies replacement of a busy file.
      await this.io.rename(stage, this.exePath);
      replaced = true;
      // Once replacement begins, finish verification/rollback even during exit.
      if (await this.runVersion(this.exePath) !== journal.newVersion) throw fault('BAD_VERSION', '替换后的引擎试运行失败');
      await this.io.unlink(this.journalPath);
      finalized = true;
      await this.io.rename(backup, `${this.exePath}.previous`).catch(() => {});
      this._set({ installedVersion: journal.newVersion, status: 'updated', progress: 100, message: `已更新至 yt-dlp ${journal.newVersion}，旧版备份已保留。`, canUpdate: false });
      }
    } catch (error) {
      if (!releaseConfirmed) { this.lastCheckSuccess = false; this._set({ checkedAt: this.now() }); }
      if (error.engineUnsafe) this._set({ engineReady: false });
      if (replaced && !finalized) {
        try {
          await this.io.rename(backup, this.exePath);
          if (await this.runVersion(this.exePath) !== journal.oldVersion || sha256(await this.io.readFile(this.exePath)) !== journal.oldHash) throw fault('ROLLBACK', '回滚版本校验失败');
          await this.io.unlink(this.journalPath);
          journal = null;
          this._set({ installedVersion: this.state.installedVersion, status: 'error', message: `${errorMessage(error)}；已恢复原引擎。` });
        } catch (rollbackError) {
          this._set({ engineReady: false, status: 'error', message: 'Windows 阻止了引擎回滚。旧版备份仍在 resources/bin，请关闭占用程序后重启烬匣，启动时会自动恢复。' });
        }
      } else {
        if (journal) { await this.io.unlink(this.journalPath).catch(() => {}); journal = null; }
        this._set({ status: 'error', message: errorMessage(error) });
      }
    } finally {
      await this.io.unlink(stage).catch(() => {});
      // Keep a recovery backup if an incomplete transaction is still on disk.
      if (!journal) await this.io.unlink(backup).catch(() => {});
      await this._saveCache();
      if (this._controller === controller) this._controller = null;
      this._set({ busy: false, canUpdate: this.state.engineReady && this._available() });
    }
    return this.snapshot();
  }
  async _recover() {
    let journal;
    try { journal = JSON.parse(await this.io.readFile(this.journalPath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw fault('RECOVERY', '更新事务记录无法读取，请保留 resources/bin 中的备份并联系维护者。'); }
    if (journal.schema !== 1 || !/^\.yt-dlp-[a-f0-9-]{36}\.pending\.exe$/.test(journal.stage) || !/^\.yt-dlp-[a-f0-9-]{36}\.backup\.exe$/.test(journal.backup) || !validVersion(journal.oldVersion) || !validVersion(journal.newVersion) || !HASH.test(journal.oldHash) || !HASH.test(journal.newHash)) throw fault('RECOVERY', '更新事务记录无效，已停止使用引擎以保护原文件。');
    const releaseLock = this.acquireLock();
    const backup = path.join(path.dirname(this.exePath), journal.backup);
    const stage = path.join(path.dirname(this.exePath), journal.stage);
    try {
      let currentHash = '';
      try { currentHash = sha256(await this.io.readFile(this.exePath)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (currentHash === journal.newHash && await this.runVersion(this.exePath).catch(() => '') === journal.newVersion) {
        await this.io.unlink(this.journalPath);
        await this.io.rename(backup, `${this.exePath}.previous`).catch(() => {});
      } else if (currentHash === journal.oldHash && await this.runVersion(this.exePath).catch(() => '') === journal.oldVersion) {
        await this.io.unlink(this.journalPath);
        await this.io.unlink(backup).catch(() => {});
      } else {
        if (sha256(await this.io.readFile(backup)) !== journal.oldHash || await this.runVersion(backup) !== journal.oldVersion) throw fault('RECOVERY', '旧版备份无法通过校验，请保留备份并联系维护者。');
        await this.io.rename(backup, this.exePath);
        if (await this.runVersion(this.exePath) !== journal.oldVersion) throw fault('RECOVERY', '自动恢复旧版失败，请关闭占用程序后重启。');
        await this.io.unlink(this.journalPath);
      }
      await this.io.unlink(stage).catch(() => {});
    } finally { releaseLock(); }
  }
  async shutdown() {
    this._closed = true;
    this._controller?.abort();
    await Promise.allSettled([this._checkPromise, this._installPromise, this._initPromise].filter(Boolean));
  }
}

module.exports = { EngineUpdater, requestOfficial, createElectronRequest, releaseMetadata, officialChecksum, approvedUrl, probeVersion, compareVersions };
