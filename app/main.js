'use strict';
const { app, BrowserWindow, dialog, ipcMain, protocol, net, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { QueueManager } = require('./lib/core');
const { ChannelScanner } = require('./lib/channels');
const { ChannelImporter } = require('./lib/channel-import');
const { EngineUpdater, createElectronRequest } = require('./lib/updater');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }
]);
app.setName('Cinder Vault');
let window, manager, scanner, importer, updater, updateTimer, broadcastTimer, backgrounds = [], engine = {}, allowClose = false, shuttingDown = false;
let queueView = { page: 1, filter: 'all' };
const sourceRoot = __dirname;
const portableRoot = app.isPackaged ? path.dirname(process.execPath) : sourceRoot;
let backgroundRoot = path.join(portableRoot, 'backgrounds');
const uiRoot = path.join(sourceRoot, 'ui');
const entry = 'app://cinder/index.html';

function attachWindowIcons() {
  if (process.platform !== 'win32' || !window || window.isDestroyed()) return;
  const helper = path.join(sourceRoot, 'native', 'WindowIcons.exe');
  const small = path.join(sourceRoot, 'assets', 'window-icon.ico');
  const large = path.join(sourceRoot, 'assets', 'icon.ico');
  if (![helper, small, large].every(file => fs.existsSync(file))) return;
  const handle = window.getNativeWindowHandle();
  const hwnd = handle.length >= 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE());
  const child = spawn(helper, [hwnd, String(process.pid), process.execPath, small, large], { windowsHide: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function resolveResource(root, rawPath) {
  const decoded = decodeURIComponent(rawPath);
  if (decoded.includes('\0') || decoded.includes('\\')) throw new Error('invalid resource path');
  const target = path.resolve(root, `.${decoded}`);
  if (!contained(root, target)) throw new Error('resource outside root');
  return target;
}
function rendererAuthorized(event) {
  if (!window || event.sender.id !== window.webContents.id || event.senderFrame !== window.webContents.mainFrame) return false;
  try { const u = new URL(event.senderFrame.url); return u.protocol === 'app:' && u.hostname === 'cinder' && u.pathname === '/index.html'; } catch { return false; }
}
function withSender(fn) {
  return async (event, ...args) => {
    if (!rendererAuthorized(event)) throw new Error('拒绝未知页面的请求');
    return fn(...args);
  };
}
async function listBackgrounds() {
  try {
    const entries = await fsp.readdir(backgroundRoot, { withFileTypes: true });
    backgrounds = entries.filter(e => e.isFile() && /^background\.mp4$/i.test(e.name)).slice(0, 1).map(e => ({ name: 'background.mp4', url: `media://backgrounds/${encodeURIComponent(e.name)}` }));
  } catch { backgrounds = []; }
  return backgrounds;
}
function snapshot(view) {
  if (view && typeof view === 'object') queueView = { page: Number.isSafeInteger(view.page) ? view.page : queueView.page, filter: ['all', 'active', 'completed', 'failed'].includes(view.filter) ? view.filter : queueView.filter };
  const current = manager.snapshot(queueView);
  queueView.page = current.queue.page;
  return { ...current, engine: { ...engine, ...current.engine }, updater: updater?.snapshot(), channel: { ...(scanner?.snapshot() || {}), importing: Boolean(importer?.busy), importMessage: importer?.message || '', busy: Boolean(scanner?.busy), unsafeStop: Boolean(scanner?.unsafeStop) }, backgrounds, appVersion: app.getVersion(), backgroundDir: backgroundRoot };
}
function broadcast() {
  if (broadcastTimer || shuttingDown) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    if (window && !window.isDestroyed()) window.webContents.send('downloader:state', snapshot());
  }, 250);
}
function updaterChanged() {
  if (updater.snapshot().engineReady === false) {
    manager.engine.ready = false;
    manager.engine.error = updater.snapshot().message || '下载引擎恢复失败，请退出后重新解压完整程序；旧版备份已保留。';
  }
  broadcast();
}
async function setupDirectories() {
  let dataRoot = path.join(portableRoot, 'data');
  if (process.env.CINDER_TEST_DATA_DIR) dataRoot = path.resolve(process.env.CINDER_TEST_DATA_DIR);
  try { await fsp.mkdir(dataRoot, { recursive: true }); await fsp.access(dataRoot, fs.constants.W_OK); }
  catch { dataRoot = app.getPath('userData'); await fsp.mkdir(dataRoot, { recursive: true }); }
  try { await fsp.mkdir(backgroundRoot, { recursive: true }); }
  catch { backgroundRoot = path.join(dataRoot, 'backgrounds'); await fsp.mkdir(backgroundRoot, { recursive: true }); }
  return dataRoot;
}
function binaryPaths() {
  const windows = process.platform === 'win32';
  const bin = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(sourceRoot, 'vendor', windows ? 'bin-win32' : 'bin-linux');
  return {
    ytDlp: path.join(bin, windows ? 'yt-dlp.exe' : 'yt-dlp'),
    ffmpeg: app.isPackaged || windows ? path.join(bin, windows ? 'ffmpeg.exe' : 'ffmpeg') : '/usr/bin/ffmpeg',
    jsRuntime: app.isPackaged || windows ? path.join(bin, windows ? 'node.exe' : 'node') : process.env.CINDER_NODE_PATH || '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node'
  };
}
async function registerProtocols() {
  protocol.handle('app', request => {
    try {
      const u = new URL(request.url);
      if (u.hostname !== 'cinder') return new Response('Forbidden', { status: 403 });
      return net.fetch(pathToFileURL(resolveResource(uiRoot, u.pathname)).href);
    } catch { return new Response('Not found', { status: 404 }); }
  });
  protocol.handle('media', async request => {
    try {
      const u = new URL(request.url);
      if (u.hostname !== 'backgrounds' || !/^\/background\.mp4$/i.test(u.pathname)) return new Response('Forbidden', { status: 403 });
      const file = resolveResource(backgroundRoot, u.pathname);
      if (path.dirname(file) !== backgroundRoot || !(await fsp.lstat(file)).isFile()) return new Response('Forbidden', { status: 403 });
      return net.fetch(pathToFileURL(file).href, { headers: request.headers });
    } catch { return new Response('Not found', { status: 404 }); }
  });
}
async function openPathSafe(target) {
  await fsp.mkdir(target, { recursive: true });
  const error = await shell.openPath(target);
  if (error) throw new Error(error);
  return true;
}
function registerIPC() {
  const handlers = {
    getState: snapshot,
    add: (text, settings) => manager.add(text, settings),
    start: () => { manager.start(); return true; },
    pause: async () => { importer.suppressAutostart(); await manager.pause(); return true; },
    cancel: async id => { await manager.cancel(id); return true; },
    retry: id => { manager.retry(id); return true; },
    remove: id => { manager.remove(id); return true; },
    clearFinished: () => { manager.clearFinished(); return true; },
    scanChannel: options => {
      if (shuttingDown || importer.busy) throw new Error('正在加入频道视频或退出，请稍候');
      manager._assertEngineNotUpdating();
      if (!manager.engine.ready) throw new Error(manager.engine.error || '下载引擎尚未就绪');
      importer.message = '';
      return scanner.start(options);
    },
    cancelChannelScan: () => scanner.cancel(),
    getChannelEntries: view => scanner.list(view),
    downloadChannel: (settings, selection) => importer.start(settings, selection),
    checkUpdates: () => updater.check({ force: true }),
    installUpdate: () => updater.install(),
    updateSettings: settings => { manager.updateSettings(settings); return true; },
    chooseOutput: async () => {
      const choice = await dialog.showOpenDialog(window, { title: '选择视频保存位置', defaultPath: manager.settings.outputDir, properties: ['openDirectory', 'createDirectory'] });
      if (choice.canceled || !choice.filePaths[0]) return null;
      await manager.updateSettings({ outputDir: choice.filePaths[0] });
      return choice.filePaths[0];
    },
    openOutput: () => openPathSafe(manager.settings.outputDir),
    showFile: async id => {
      const job = manager.jobs.find(j => j.id === id);
      if (!job || job.status !== 'completed' || !job.outputPath || typeof job.outputDir !== 'string') throw new Error('文件尚未就绪');
      const file = path.resolve(job.outputPath);
      if (!contained(path.resolve(job.outputDir), file) || !fs.existsSync(file)) throw new Error('文件已被移动或不存在');
      shell.showItemInFolder(file);
      return true;
    },
    openBackgrounds: () => openPathSafe(backgroundRoot),
    refreshBackgrounds: async () => { await listBackgrounds(); broadcast(); return backgrounds; }
  };
  for (const [name, fn] of Object.entries(handlers)) ipcMain.handle(`downloader:${name}`, withSender(fn));
}
async function createWindow() {
  window = new BrowserWindow({
    width: 1380, height: 900, minWidth: 1040, minHeight: 720, backgroundColor: '#11100e', show: false,
    title: '烬匣 · 批量视频下载器', icon: path.join(sourceRoot, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(sourceRoot, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, spellcheck: false }
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== entry) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.once('ready-to-show', () => { window.show(); attachWindowIcons(); });
  window.on('close', async event => {
    if (allowClose) return;
    event.preventDefault();
    if (shuttingDown) return;
    const active = manager._active.size > 0 || scanner.busy || importer.busy;
    if (active) {
      const answer = await dialog.showMessageBox(window, { type: 'question', title: '暂停并退出？', message: '仍有下载或频道扫描正在进行', detail: '退出会停止任务并保留已找到的视频与下载队列，下次打开后可手动继续。未完成的频道可重新扫描。', buttons: ['返回下载', '暂停并退出'], defaultId: 0, cancelId: 0, noLink: true });
      if (answer.response !== 1) return;
    }
    shuttingDown = true;
    clearInterval(updateTimer);
    clearTimeout(broadcastTimer);
    await importer.shutdown();
    await scanner.shutdown();
    await manager.shutdown();
    await updater.shutdown();
    allowClose = true;
    window.close();
  });
  await window.loadURL(entry);
}
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    await registerProtocols();
    const dataRoot = await setupDirectories();
    const binaries = binaryPaths();
    manager = new QueueManager({ statePath: path.join(dataRoot, 'queue.json'), defaultOutputDir: path.join(app.getPath('downloads'), 'CinderVault'), binaries });
    // Restored queues start paused; no window or IPC exists during recovery.
    await manager.init();
    scanner = new ChannelScanner({ binaries, statePath: path.join(dataRoot, 'channel-scan.json'), canStart: () => {
      if (shuttingDown || importer?.busy) throw new Error('频道导入或退出期间不能扫描');
      manager._assertEngineNotUpdating();
      if (!manager.engine.ready) throw new Error(manager.engine.error || '下载引擎尚未就绪');
    } });
    await scanner.init();
    importer = new ChannelImporter({ manager, scanner, onChange: broadcast });
    scanner.on('change', broadcast);
    updater = new EngineUpdater({ exePath: binaries.ytDlp, cachePath: path.join(dataRoot, 'engine-update.json'), acquireLock: () => {
      if (scanner.busy || scanner.unsafeStop || importer.busy) throw new Error('请先停止频道扫描并等待导入结束，再更新引擎');
      return manager.acquireEngineUpdate();
    }, deps: { request: createElectronRequest(net) } });
    await updater.init();
    // A journal recovery may have restored a previously missing executable.
    manager.engine.missing = ['ytDlp', 'ffmpeg', 'jsRuntime'].filter(key => !fs.existsSync(binaries[key]));
    manager.engine.ready = manager.engine.missing.length === 0 && updater.snapshot().engineReady !== false;
    if (manager.engine.ready) manager.engine.error = '';
    updater.on('change', updaterChanged);
    updaterChanged();
    const names = { ytDlp: 'yt-dlp', ffmpeg: 'FFmpeg', jsRuntime: 'Node.js' };
    const present = Object.fromEntries(Object.entries(binaries).map(([k, p]) => [k, fs.existsSync(p)]));
    engine = { ...present, ready: Object.values(present).every(Boolean), missing: Object.entries(present).filter(([, exists]) => !exists).map(([k]) => names[k]) };
    await listBackgrounds();
    manager.on('change', broadcast);
    registerIPC();
    await createWindow();
    const checkUpdates = () => { if (!shuttingDown) void updater.check().catch(() => {}); };
    setTimeout(checkUpdates, 2000).unref();
    updateTimer = setInterval(checkUpdates, 60 * 60 * 1000);
    updateTimer.unref();
  }).catch(error => { dialog.showErrorBox('烬匣启动失败', String(error.stack || error)); app.exit(1); });
  app.on('window-all-closed', () => app.quit());
}
