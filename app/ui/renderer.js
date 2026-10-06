'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const preview = !window.downloader;
  const activeStatuses = new Set(['downloading', 'processing']);
  const waitingStatuses = new Set(['queued', 'paused']);
  const finishedStatuses = new Set(['completed', 'failed', 'cancelled']);
  const labels = { queued: '等待下载', downloading: '正在下载', processing: '正在处理', completed: '已完成', failed: '下载失败', cancelled: '已取消', paused: '已暂停' };
  let state = { settings: { outputDir: '', quality: 'best', concurrency: 2 }, jobs: [], paused: false, engine: {}, updater: {}, channel: { status: 'idle', discovered: 0, skipped: 0, warnings: [] }, backgrounds: [], appVersion: '1.0.5' };
  let filter = 'all';
  let page = 1;
  let pendingPageRequest = 0;
  let isBusy = false;
  let pendingUpdateAction = '';
  let pendingChannelAction = '';
  let channelInputDirty = false;
  let channelInputsInitialized = false;
  let channelFeedback = '';
  let channelFeedbackError = false;
  let selectedScanId = '';
  const selectedChannelIds = new Set();
  const excludedChannelIds = new Set();
  let allChannelSelected = false;
  let channelEntries = { entries: [], total: 0, filteredTotal: 0, page: 1, pages: 1 };
  let channelQuery = '';
  let channelListLoading = false;
  let channelListError = '';
  let channelListRequest = 0;
  let channelListKey = '';
  let pendingQuality = null;
  let qualityEditVersion = 0;
  const pendingJobIds = new Set();
  let hasInitialized = false;
  let backgroundChoice = '';
  let failedBackgroundUrl = '';
  let motionEnabled = readPreference('cinder.motion', 'true') !== 'false';
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let settingsChain = Promise.resolve();
  const api = window.downloader || createPreviewBridge();

  function readPreference(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
  function savePreference(key, value) { try { localStorage.setItem(key, value); } catch { /* Storage may be unavailable in preview. */ } }
  function errorMessage(error) { return error?.message || String(error || '操作未完成，请重试'); }
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`); svg.append(use); svg.setAttribute('aria-hidden', 'true'); return svg;
  }
  function el(tag, className, value) { const node = document.createElement(tag); if (className) node.className = className; if (value !== undefined) node.textContent = String(value); return node; }
  function toast(message, type = '') {
    const node = el('div', `toast ${type}`.trim()); node.append(icon(type === 'error' ? 'help' : 'check'), el('span', '', message));
    $('toastRegion').append(node);
    while ($('toastRegion').children.length > 3) $('toastRegion').firstElementChild.remove();
    setTimeout(() => node.remove(), type === 'error' ? 7000 : 4500);
  }
  async function refreshState() { const snapshot = await api.getState({ page, filter }); if (snapshot) applyState(snapshot); }
  async function changeQueueView(nextPage, nextFilter = filter) {
    if (pendingPageRequest) return;
    const previous = { page, filter };
    page = nextPage; filter = nextFilter; pendingPageRequest++;
    renderPagination();
    try { await refreshState(); }
    catch (error) { page = previous.page; filter = previous.filter; toast(errorMessage(error), 'error'); }
    finally { pendingPageRequest--; renderPagination(); renderFilterTabs(); }
  }
  async function operation(button, action, success) {
    if (button?.dataset.pending === 'true') return;
    if (button) { button.dataset.pending = 'true'; button.disabled = true; }
    try { const result = await action(); await refreshState(); if (success) toast(typeof success === 'function' ? success(result) : success); return result; }
    catch (error) { toast(errorMessage(error), 'error'); return undefined; }
    finally { if (button) { delete button.dataset.pending; button.disabled = false; } updateControls(); }
  }
  function getSettings() { return { outputDir: $('outputDir').value, quality: $('quality').value, concurrency: Number($('concurrency').value) }; }
  function persistSettings() {
    const settings = getSettings();
    const job = settingsChain.catch(() => {}).then(() => api.updateSettings(settings));
    settingsChain = job; return job;
  }
  function applyState(snapshot) {
    const previousSettings = state.settings;
    state = { ...state, ...snapshot, settings: { ...state.settings, ...(snapshot.settings || {}) }, engine: { ...state.engine, ...(snapshot.engine || {}) }, updater: { ...state.updater, ...(snapshot.updater || {}) }, channel: { ...state.channel, ...(snapshot.channel || {}) }, jobs: Array.isArray(snapshot.jobs) ? snapshot.jobs : state.jobs, backgrounds: Array.isArray(snapshot.backgrounds) ? snapshot.backgrounds : state.backgrounds };
    if (state.queue) page = Number(state.queue.page) || 1;
    if (!hasInitialized || previousSettings.outputDir !== state.settings.outputDir) $('outputDir').value = state.settings.outputDir || '';
    $('outputDir').title = state.settings.outputDir || '尚未选择下载目录';
    if (pendingQuality !== null) $('quality').value = pendingQuality;
    else if (!hasInitialized || previousSettings.quality !== state.settings.quality) $('quality').value = state.settings.quality || 'best';
    $('channelQuality').value = $('quality').value || 'best';
    $('channelOutputDir').value = $('outputDir').value;
    $('channelOutputDir').title = $('outputDir').value;
    if (!hasInitialized || Number(previousSettings.concurrency) !== Number(state.settings.concurrency)) $('concurrency').value = String(state.settings.concurrency || 2);
    $('settingsOutput').textContent = state.settings.outputDir || '尚未选择下载目录';
    $('appVersion').textContent = `v${state.appVersion || '1.0.5'}`;
    if (!channelInputsInitialized && state.channel.url) {
      $('channelUrl').value = state.channel.url;
      if (Array.isArray(state.channel.tabs)) for (const box of channelTypeInputs()) box.checked = state.channel.tabs.includes(box.value);
    }
    channelInputsInitialized = true;
    hasInitialized = true;
    syncChannelScan();
    renderSummary(); renderEngine(); renderJobs(); renderBackgrounds(); renderChannel(); updateControls();
    syncChannelEntries();
  }
  function queueCounts() {
    return state.queue?.counts || {
      completed: state.jobs.filter(job => job.status === 'completed').length,
      active: state.jobs.filter(job => activeStatuses.has(job.status)).length,
      waiting: state.jobs.filter(job => waitingStatuses.has(job.status)).length,
      failed: state.jobs.filter(job => job.status === 'failed').length
    };
  }
  function renderSummary() {
    const { completed, active, waiting, failed } = queueCounts();
    const total = state.queue?.total ?? state.jobs.length;
    $('completedCount').textContent = String(completed).padStart(2, '0');
    $('runningCount').textContent = String(active); $('waitingCount').textContent = String(waiting); $('failedCount').textContent = String(failed);
    $('queueCount').textContent = String(total); $('activeCount').textContent = String(active);
    $('queueStateDot').classList.toggle('running', active > 0 && !state.paused);
    $('queueStateText').textContent = state.paused ? '队列已暂停，点击继续恢复' : active ? `${active} 个任务正在处理` : waiting ? `${waiting} 个任务等待下载` : !total ? '等待添加任务' : failed ? `${failed} 个任务未成功，可单独重试` : '队列处理完毕';
  }
  function componentAvailable(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return Boolean(value) && value !== 'missing' && value !== 'unavailable';
    if (value && typeof value === 'object') return Boolean(value.available ?? value.ready ?? value.ok ?? value.installed ?? value.path);
    return false;
  }
  function renderEngine() {
    const ready = !preview && Boolean(state.engine.ready);
    $('engineReady').textContent = preview ? '预览模式' : ready ? '准备就绪' : '需要检查';
    $('engineReady').className = `engine-badge ${ready ? 'ready' : 'unready'}`;
    for (const [name, id] of [['ytDlp', 'ytDlpState'], ['ffmpeg', 'ffmpegState'], ['jsRuntime', 'runtimeState']]) {
      const value = state.engine[name]; const available = !preview && componentAvailable(value);
      $(id).textContent = preview ? '未连接' : available ? '已就绪' : '未检测到';
      $(id).className = `component-status ${available ? 'good' : preview ? '' : 'bad'}`;
      $(id).title = typeof value === 'object' && value ? String(value.version || value.error || value.path || '') : '';
    }
    $('engineNote').textContent = preview ? '界面预览，未连接下载引擎。请在桌面应用中使用下载功能。' : ready ? '本地引擎已连接，随时开始你的下一次收藏。' : (state.engine.error || '请检查依赖安装。打开使用指南了解需要准备的本地引擎。');
    if (state.engine.persistenceError) $('engineNote').textContent += ` ${state.engine.persistenceError}`;
  }
  function matchesFilter(job) { return filter === 'all' || (filter === 'active' ? activeStatuses.has(job.status) : job.status === filter); }
  function updateBlockedByQueue() {
    return queueCounts().active > 0 || (!state.paused && (state.queue?.hasQueued ?? state.jobs.some(job => job.status === 'queued')));
  }
  function engineIsUpdating() { return Boolean(state.engine.updating || pendingUpdateAction === 'install'); }
  async function runUpdateAction(kind) {
    if (pendingUpdateAction || state.updater?.busy || state.engine.updating || preview) return;
    if (kind === 'install' && (isBusy || channelBusy() || updateBlockedByQueue() || !state.updater?.canUpdate)) {
      if (updateBlockedByQueue()) toast('请先暂停队列，等待任务停止后更新');
      return;
    }
    pendingUpdateAction = kind; updateControls(); renderJobs();
    try { await operation($(kind === 'check' ? 'checkEngineUpdate' : 'installEngineUpdate'), () => kind === 'check' ? api.checkUpdates() : api.installUpdate()); }
    finally { pendingUpdateAction = ''; updateControls(); renderJobs(); }
  }
  function renderUpdater() {
    const updater = state.updater || {};
    const installing = engineIsUpdating();
    const busy = Boolean(updater.busy || installing || pendingUpdateAction);
    const queueBlocked = updateBlockedByQueue();
    const available = !preview && typeof api.checkUpdates === 'function' && typeof api.installUpdate === 'function';
    const component = state.engine.ytDlp;
    $('installedEngineVersion').textContent = String(updater.installedVersion || (component && typeof component === 'object' && component.version) || '待检测');
    $('latestEngineVersion').textContent = String(updater.latestVersion || '尚未检查');
    const checkDate = updater.checkedAt ? new Date(updater.checkedAt) : null;
    $('engineUpdateChecked').textContent = checkDate && Number.isFinite(checkDate.getTime()) ? `上次检查：${checkDate.toLocaleString('zh-CN', { hour12: false })}` : '上次检查：尚未检查';
    const statusLabels = { idle: '启动后自动检查官方稳定版', checking: '正在检查官方稳定版…', available: '发现新版本，可在队列空闲时更新', current: '已是最新官方稳定版', downloading: '正在下载官方引擎…', verifying: '正在验证下载及运行版本…', installing: '正在更新本地引擎…', updated: '引擎已更新，可以继续下载', error: '检查或更新未完成，请重试' };
    $('engineUpdateMessage').textContent = preview ? '预览模式未连接引擎更新服务' : String(updater.message || statusLabels[updater.status] || statusLabels.idle);
    $('engineUpdateMessage').classList.toggle('is-error', updater.status === 'error');
    $('engineUpdateQueueNote').hidden = (!queueBlocked && !channelBusy()) || installing;
    $('engineUpdateQueueNote').textContent = channelBusy() ? '请先停止频道扫描或等待任务加入队列，再更新引擎。' : '请先暂停队列，等待任务停止后更新。';
    const percent = Number(typeof updater.progress === 'object' && updater.progress ? updater.progress.percent : updater.progress);
    const showProgress = busy && updater.progress !== null && updater.progress !== undefined && Number.isFinite(percent);
    $('engineUpdateProgress').hidden = !showProgress;
    $('engineUpdateProgress').value = Math.max(0, Math.min(100, showProgress ? percent : 0));
    $('checkEngineUpdate').disabled = !available || busy || $('checkEngineUpdate').dataset.pending === 'true';
    $('installEngineUpdate').disabled = !available || busy || isBusy || channelBusy() || queueBlocked || !updater.canUpdate || $('installEngineUpdate').dataset.pending === 'true';
    $('checkEngineUpdate').textContent = updater.status === 'checking' || pendingUpdateAction === 'check' ? '正在检查…' : '检查更新';
    $('installEngineUpdate').textContent = installing ? '正在更新…' : '一键更新';
    $('installEngineUpdate').title = channelBusy() ? '请先停止频道扫描或等待任务加入队列' : queueBlocked ? '请先暂停队列，等待任务停止后更新' : !updater.canUpdate ? '检查到新版本后可更新' : '仅更新官方稳定版 yt-dlp 引擎';
    $('engineUpdater').setAttribute('aria-busy', String(busy));
  }
  function progressNumber(job) { const raw = typeof job.progress === 'object' && job.progress ? job.progress.percent : job.progress; const value = Number.parseFloat(raw); return job.status === 'completed' ? 100 : Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0; }
  function platformName(job) {
    if (job.platform) return String(job.platform);
    try { const host = new URL(job.url).hostname.replace(/^www\./, ''); if (host.includes('youtu')) return 'YouTube'; if (host.includes('bilibili') || host === 'b23.tv') return 'Bilibili'; return host; } catch { return '视频'; }
  }
  function formatSpeed(value) { if (!value) return ''; if (typeof value === 'number') return value >= 1048576 ? `${(value / 1048576).toFixed(1)} MB/s` : `${Math.round(value / 1024)} KB/s`; return String(value); }
  function formatEta(value) { if (value === undefined || value === null || value === '') return ''; if (typeof value === 'number') { const n = Math.max(0, Math.floor(value)); return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`; } return String(value); }
  function makeJobAction(name, label, action, job) {
    const button = el('button', 'job-action'); button.type = 'button'; button.title = label; button.setAttribute('aria-label', `${label}：${job.title || job.url}`); button.dataset.action = name; button.dataset.jobId = String(job.id); button.append(icon(name));
    if (name === 'refresh') button.append(el('span', '', '重试'));
    button.disabled = pendingJobIds.has(job.id) || (name === 'refresh' && engineIsUpdating());
    button.addEventListener('click', async () => {
      if (pendingJobIds.has(job.id) || (name === 'refresh' && engineIsUpdating())) return;
      pendingJobIds.add(job.id);
      try { await operation(button, action); } finally { pendingJobIds.delete(job.id); renderJobs(); }
    }); return button;
  }
  function channelTypeInputs() { return ['channelVideos', 'channelShorts', 'channelStreams'].map($); }
  function channelBusy() { return state.channel.status === 'scanning' || Boolean(state.channel.busy || state.channel.unsafeStop || state.channel.importing || pendingChannelAction); }
  function channelIsPartial() {
    return state.channel.status !== 'ready' || Boolean(state.channel.partial || state.channel.incomplete);
  }
  function qualityLabel(value) { return { best: '最佳画质', '1080': '1080p 上限', '720': '720p 上限', '480': '480p 上限', audio: 'MP3 仅音频' }[value] || '最佳画质'; }
  function channelSelectionCount() { return allChannelSelected ? Math.max(0, Number(state.channel.discovered || 0) - excludedChannelIds.size) : selectedChannelIds.size; }
  function channelEntrySelected(id) { return allChannelSelected ? !excludedChannelIds.has(id) : selectedChannelIds.has(id); }
  function channelSelectionEditable() { return !preview && Boolean(selectedScanId) && !channelBusy() && !channelInputDirty && Number(state.channel.discovered) > 0; }
  function clearChannelSelection() { selectedChannelIds.clear(); excludedChannelIds.clear(); allChannelSelected = false; }
  function syncChannelScan() {
    const scanId = state.channel.scanId || '';
    if (scanId === selectedScanId) return;
    selectedScanId = scanId; clearChannelSelection();
    channelEntries = { entries: [], total: 0, filteredTotal: 0, page: 1, pages: 1 };
    channelQuery = ''; $('channelSearch').value = '';
    channelListRequest++; channelListLoading = false; channelListError = ''; channelListKey = '';
  }
  function syncChannelEntries() {
    if (!selectedScanId || state.channel.status === 'scanning' || state.channel.busy || pendingChannelAction === 'scan' || typeof api.getChannelEntries !== 'function') return;
    const key = `${selectedScanId}:${state.channel.status}:${Number(state.channel.discovered) || 0}`;
    if (key === channelListKey) return;
    channelListKey = key;
    void loadChannelEntries(channelEntries.page, channelQuery);
  }
  async function loadChannelEntries(nextPage = 1, query = channelQuery) {
    if (!selectedScanId || preview || typeof api.getChannelEntries !== 'function') return;
    const scanId = selectedScanId; const request = ++channelListRequest;
    channelListLoading = true; channelListError = ''; renderChannelSelection(); updateChannelControls();
    try {
      const result = await api.getChannelEntries({ scanId, page: nextPage, query });
      if (request !== channelListRequest || scanId !== selectedScanId || result.scanId !== selectedScanId) return;
      channelQuery = query;
      channelEntries = { ...result, entries: Array.isArray(result.entries) ? result.entries.slice(0, 50) : [] };
    } catch (error) { if (request === channelListRequest && scanId === selectedScanId) channelListError = errorMessage(error); }
    finally { if (request === channelListRequest) { channelListLoading = false; renderChannelSelection(); updateChannelControls(); } }
  }
  function setChannelEntrySelected(id, checked) {
    if (allChannelSelected) { if (checked) excludedChannelIds.delete(id); else excludedChannelIds.add(id); }
    else { if (checked) selectedChannelIds.add(id); else selectedChannelIds.delete(id); }
  }
  function renderChannelSelection() {
    $('channelSelection').hidden = !selectedScanId || Number(state.channel.discovered) === 0;
    const editable = channelSelectionEditable() && !channelListLoading;
    const count = channelSelectionCount();
    $('channelSelectedCount').textContent = `已选 ${count} / ${Number(state.channel.discovered) || 0} 个`;
    $('channelSelectionMode').textContent = allChannelSelected ? `已全选所有扫描结果${excludedChannelIds.size ? `，排除 ${excludedChannelIds.size} 个` : ''}；搜索不会缩小此选择范围。` : '默认不勾选；翻页或搜索会保留你的选择。';
    $('channelListMessage').textContent = channelListLoading ? '正在读取视频列表…' : channelListError || (channelEntries.entries.length ? '' : state.channel.status === 'scanning' ? '扫描完成后可浏览和选择视频。' : channelQuery ? '没有匹配的视频，请更换搜索词。' : '没有可显示的视频。');
    $('channelListMessage').hidden = !channelListLoading && !channelListError && channelEntries.entries.length > 0;
    $('channelListMessage').classList.toggle('channel-warning', Boolean(channelListError));
    const names = { videos: '普通视频', shorts: 'Shorts', streams: '直播回放' };
    const fragment = document.createDocumentFragment();
    for (const entry of channelEntries.entries) {
      const row = el('label', 'channel-entry');
      const box = el('input'); box.type = 'checkbox'; box.checked = channelEntrySelected(entry.id); box.disabled = !editable; box.dataset.videoId = entry.id;
      box.setAttribute('aria-label', `选择视频：${entry.title || entry.id}`);
      box.addEventListener('change', () => { if (!channelSelectionEditable()) return; setChannelEntrySelected(entry.id, box.checked); renderChannelSelection(); updateChannelControls(); });
      const copy = el('span', 'channel-entry-copy');
      const title = el('strong', '', entry.title || entry.id); title.title = entry.title || entry.id;
      const detail = el('span', 'channel-entry-detail', `${names[entry.tab] || '视频'} · ${entry.id}`); detail.title = entry.url || '';
      copy.append(title, detail); row.append(box, copy); fragment.append(row);
    }
    $('channelEntryList').replaceChildren(fragment);
    const pageSelected = channelEntries.entries.length > 0 && channelEntries.entries.every(entry => channelEntrySelected(entry.id));
    $('channelSelectPage').textContent = pageSelected ? '取消本页选择' : '本页全选';
    $('channelSelectPage').disabled = !editable || !channelEntries.entries.length;
    $('channelSelectAll').disabled = !editable || (allChannelSelected && !excludedChannelIds.size);
    $('channelClearSelection').disabled = !editable || !count;
    $('channelSearchButton').disabled = !channelSelectionEditable() || channelListLoading;
    $('channelSearch').disabled = !channelSelectionEditable();
    $('channelEntryPagination').hidden = !channelEntries.filteredTotal;
    $('channelEntryPageInfo').textContent = `第 ${channelEntries.page || 1} / ${channelEntries.pages || 1} 页 · ${channelQuery ? '匹配' : '共'} ${channelEntries.filteredTotal || 0} 个`;
    $('channelEntryPrevious').disabled = !editable || channelEntries.page <= 1;
    $('channelEntryNext').disabled = !editable || channelEntries.page >= channelEntries.pages;
  }
  function canImportChannel() {
    return channelSelectionEditable() && !engineIsUpdating() && channelSelectionCount() > 0 && ['ready', 'cancelled', 'error', 'interrupted'].includes(state.channel.status);
  }
  function renderChannel() {
    const channel = state.channel;
    const scanning = channel.status === 'scanning';
    const names = { videos: '普通视频', shorts: 'Shorts', streams: '直播回放' };
    const selected = Array.isArray(channel.tabs) ? channel.tabs.map(tab => names[tab] || tab).join('、') : '';
    const statusText = {
      idle: '扫描只获取列表，不会下载视频。',
      scanning: `正在扫描${names[channel.activeTab] || '频道'}… 大频道可能需要较长时间，可随时停止。`,
      ready: Number(channel.discovered) ? `所选范围已扫描${selected ? `（${selected}）` : ''}。请在下方勾选视频、选择画质，再下载所选内容。` : '未找到可下载的视频，可调整范围或检查频道链接后重试。',
      cancelled: '扫描已停止，已找到的列表保留。',
      error: '扫描未能正常完成，请查看错误后重新扫描。',
      interrupted: '上次扫描已中断，请重新扫描以获取完整列表。'
    };
    $('channelTitle').textContent = channel.channelTitle || channel.channelId || (channel.url ? 'YouTube 频道' : '等待输入频道');
    $('channelStats').textContent = `已找到 ${Number(channel.discovered) || 0} · 跳过 ${Number(channel.skipped) || 0}`;
    $('channelStatus').textContent = preview ? '界面预览未连接引擎，请在桌面应用中扫描频道。' : channel.unsafeStop ? '无法确认扫描进程已经停止；请退出软件并确认进程结束后重开。' : channel.importing ? '正在分批加入下载队列…' : pendingChannelAction === 'scan' ? '正在启动扫描…' : pendingChannelAction === 'cancel' ? '正在停止扫描…' : channel.busy && !scanning ? '正在保存扫描结果，请稍候…' : channelInputDirty ? '链接或下载范围已更改，请重新扫描后下载。' : statusText[channel.status] || '等待扫描频道。';
    const incomplete = !scanning && channel.status !== 'idle' && channelIsPartial();
    $('channelIncomplete').hidden = !incomplete;
    $('channelIncomplete').textContent = '本次结果可能不完整；只能从已找到的列表中选择下载。重新扫描会清空选择，下载时自动跳过队列和历史中的重复内容。';
    $('channelError').hidden = !channel.error;
    $('channelError').textContent = channel.error ? String(channel.error) : '';
    const warnings = Array.isArray(channel.warnings) ? channel.warnings : [];
    $('channelWarnings').replaceChildren(...warnings.slice(0, 5).map(warning => el('li', '', typeof warning === 'string' ? warning : warning.message || warning.error || String(warning))));
    if (warnings.length > 5) $('channelWarnings').append(el('li', '', `另有 ${warnings.length - 5} 条扫描提示。`));
    $('channelWarnings').hidden = !warnings.length;
    const importMessage = channel.importing ? channel.importMessage : channelFeedback || channel.importMessage;
    $('channelImportMessage').hidden = !importMessage;
    $('channelImportMessage').textContent = importMessage || '';
    $('channelImportMessage').classList.toggle('channel-warning', channelFeedbackError);
    $('channelPanel').setAttribute('aria-busy', String(channelBusy()));
    renderChannelSelection();
  }
  function updateChannelControls() {
    const busy = channelBusy();
    const scanning = state.channel.status === 'scanning';
    const available = !preview && typeof api.scanChannel === 'function' && typeof api.downloadChannel === 'function';
    $('channelUrl').disabled = busy;
    for (const box of channelTypeInputs()) box.disabled = busy;
    $('scanChannel').disabled = !available || busy || engineIsUpdating() || !$('channelUrl').value.trim() || !channelTypeInputs().some(box => box.checked);
    $('scanChannel').textContent = scanning || pendingChannelAction === 'scan' ? '正在扫描…' : state.channel.status === 'idle' ? '扫描频道' : '重新扫描';
    $('cancelChannelScan').hidden = !scanning;
    $('cancelChannelScan').disabled = !scanning || Boolean(pendingChannelAction) || typeof api.cancelChannelScan !== 'function';
    $('downloadChannel').disabled = !available || !canImportChannel();
    $('downloadChannelLabel').textContent = state.channel.importing || pendingChannelAction === 'import' ? '正在加入队列…' : `下载所选 ${channelSelectionCount()} 个`;
    $('channelDownloadSummary').textContent = `已选 ${channelSelectionCount()} 个 · ${qualityLabel($('quality').value)}${channelIsPartial() && state.channel.status !== 'idle' ? ' · 扫描结果不完整' : ''}`;
    $('channelQuality').disabled = Boolean(state.channel.importing || pendingChannelAction === 'import');
    $('channelChooseOutput').disabled = Boolean(state.channel.importing || pendingChannelAction === 'import');
    $('downloadChannel').title = channelInputDirty ? '链接或范围已更改，请先重新扫描' : engineIsUpdating() ? '引擎更新中，请稍后再试' : '按当前画质和保存位置下载，自动跳过重复内容';
  }
  async function scanChannel() {
    if ($('scanChannel').disabled || channelBusy() || engineIsUpdating()) return;
    const input = { url: $('channelUrl').value.trim(), tabs: channelTypeInputs().filter(box => box.checked).map(box => box.value) };
    clearChannelSelection(); channelListRequest++; channelListLoading = false;
    pendingChannelAction = 'scan'; channelFeedback = ''; channelFeedbackError = false; updateControls(); renderChannel();
    try { await api.scanChannel(input); channelInputDirty = false; await refreshState(); }
    catch (error) { channelInputDirty = true; channelFeedback = errorMessage(error); channelFeedbackError = true; toast(channelFeedback, 'error'); }
    finally { pendingChannelAction = ''; updateControls(); renderChannel(); syncChannelEntries(); }
  }
  async function cancelChannelScan() {
    if (pendingChannelAction || state.channel.status !== 'scanning') return;
    pendingChannelAction = 'cancel'; updateControls(); renderChannel();
    try { await api.cancelChannelScan(); await refreshState(); }
    catch (error) { toast(errorMessage(error), 'error'); }
    finally { pendingChannelAction = ''; updateControls(); renderChannel(); }
  }
  async function downloadChannel() {
    if (!canImportChannel()) return;
    const settings = getSettings();
    const selection = allChannelSelected ? { scanId: selectedScanId, all: true, excludedIds: [...excludedChannelIds] } : { scanId: selectedScanId, ids: [...selectedChannelIds] };
    pendingChannelAction = 'import'; channelFeedback = ''; channelFeedbackError = false; updateControls(); renderChannel();
    try {
      await persistSettings();
      const result = await api.downloadChannel(settings, selection);
      const count = value => Array.isArray(value) ? value.length : Number(value || 0);
      const added = count(result?.added); const duplicates = count(result?.duplicates); const historySkipped = count(result?.historySkipped); const errors = count(result?.errors); const remaining = count(result?.remaining);
      const parts = [`已加入 ${added} 个任务`, `队列重复 ${duplicates}`, `已下载跳过 ${historySkipped}`];
      if (remaining) parts.push(`还有 ${remaining} 个未加入，可查看提示后重试`);
      if (errors) parts.push(`${errors} 项未能加入`);
      channelFeedback = parts.join(' · ');
      if (result?.outputDir) channelFeedback += `\n保存至 ${result.outputDir}`;
      if (Array.isArray(result?.errors)) channelFeedback += result.errors.slice(0, 3).map(error => `\n${typeof error === 'string' ? error : error.message || error.error || '加入失败'}`).join('');
      channelFeedbackError = errors > 0 || remaining > 0;
      await refreshState();
      toast(added ? `已加入 ${added} 个频道下载任务${result.started === true ? '，所选任务已开始下载' : ''}` : result.started === true ? '已继续下载所选视频' : '没有新增任务，请查看频道扫描结果', channelFeedbackError ? 'error' : '');
    } catch (error) { channelFeedback = errorMessage(error); channelFeedbackError = true; toast(channelFeedback, 'error'); }
    finally { pendingChannelAction = ''; updateControls(); renderChannel(); }
  }
  function renderFilterTabs() {
    for (const tab of document.querySelectorAll('[data-filter]')) { const selected = tab.dataset.filter === filter; tab.classList.toggle('active', selected); tab.setAttribute('aria-selected', String(selected)); tab.disabled = Boolean(pendingPageRequest); }
  }
  function renderPagination() {
    const queue = state.queue;
    const pages = Math.max(1, Number(queue?.pages) || 1);
    $('queuePagination').hidden = !queue || !queue.filteredTotal;
    $('queuePageInfo').textContent = `第 ${page} / ${pages} 页 · 共 ${Number(queue?.filteredTotal) || 0} 项`;
    $('queuePrevious').disabled = Boolean(pendingPageRequest) || page <= 1;
    $('queueNext').disabled = Boolean(pendingPageRequest) || page >= pages;
  }
  function renderJobs() {
    const list = $('jobList');
    const focused = document.activeElement?.closest('.job-action');
    const focusId = focused?.dataset.jobId; const focusAction = focused?.dataset.action;
    const shown = state.queue ? state.jobs : state.jobs.filter(matchesFilter);
    const fragment = document.createDocumentFragment();
    for (const job of shown) {
      const card = el('article', `job-card is-${Object.hasOwn(labels, job.status) ? job.status : 'queued'}`);
      const platform = platformName(job); const stamp = platform.toLowerCase().includes('youtube') ? 'YT' : platform.toLowerCase().includes('bili') ? 'BILI' : platform.toLowerCase().includes('twitch') ? 'TW' : 'VID';
      const tile = el('div', 'job-platform', stamp); tile.title = platform;
      const content = el('div', 'job-content');
      const top = el('div', 'job-topline'); const title = el('h3', 'job-title', job.title || '等待获取视频信息'); title.title = job.title || job.url;
      const status = el('span', `job-status ${Object.hasOwn(labels, job.status) ? job.status : 'queued'}`, labels[job.status] || '等待下载');
      top.append(title, status); const url = el('p', 'job-url', job.url || ''); url.title = job.url || '';
      const progress = progressNumber(job); const bar = el('div', 'job-progress'); const fill = el('span'); fill.style.width = `${progress}%`; bar.append(fill); bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-label', `${job.title || '下载任务'}进度`); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100'); bar.setAttribute('aria-valuenow', String(Math.round(progress)));
      const bottom = el('div', 'job-bottomline');
      let detail = job.status === 'completed' ? '已保存至本地' : job.status === 'processing' ? '正在合并音视频 / 转换格式' : job.status === 'queued' ? '等待引擎处理' : job.status === 'paused' ? '恢复后将继续下载' : job.status === 'cancelled' ? '任务已取消' : job.status === 'failed' ? '可重试或移除任务' : `${progress.toFixed(1)}%`;
      if (job.status === 'downloading') { const speed = formatSpeed(job.speed); const eta = formatEta(job.eta); if (speed) detail += ` · ${speed}`; if (eta) detail += ` · 剩余 ${eta}`; }
      const actions = el('div', 'job-actions');
      if (job.status === 'completed' && job.outputPath) actions.append(makeJobAction('folder', '定位文件', () => api.showFile(job.id), job));
      if (job.status === 'failed' || job.status === 'cancelled') actions.append(makeJobAction('refresh', '重试下载', async () => { await persistSettings(); await api.retry(job.id); toast('任务已重新加入队列'); }, job));
      if (activeStatuses.has(job.status) || waitingStatuses.has(job.status)) actions.append(makeJobAction('close', '取消任务', async () => { await api.cancel(job.id); toast('任务已取消'); }, job));
      else actions.append(makeJobAction('close', '移除记录（保留文件）', async () => { await api.remove(job.id); toast('记录已移除，下载文件保留'); }, job));
      detail += ` · ${qualityLabel(job.quality)}`;
      bottom.append(el('span', 'job-details', detail), actions); content.append(top, url, bar, bottom);
      if (job.error) content.append(el('p', 'job-error', String(job.error)));
      card.append(tile, content); fragment.append(card);
    }
    list.replaceChildren(fragment); $('queueEmpty').hidden = shown.length > 0; list.hidden = shown.length === 0;
    if (focusId && focusAction) Array.from(list.querySelectorAll('.job-action')).find(button => button.dataset.jobId === focusId && button.dataset.action === focusAction)?.focus({ preventScroll: true });
    const emptyCopy = { all: ['你的收藏，从这里开始', '粘贴链接并开始下载，所有任务会在这里有序呈现'], active: ['目前没有正在下载的任务', '加入链接并开始下载，进度将在这里实时更新'], completed: ['第一份收藏，即将入匣', '已完成的下载会保留在这里，方便随时定位文件'], failed: ['一切井然有序', '暂时没有失败任务；如遇问题，可在这里重试'] };
    $('emptyTitle').textContent = emptyCopy[filter][0]; $('emptyDescription').textContent = emptyCopy[filter][1];
    renderPagination(); renderFilterTabs();
  }
  function updateControls() {
    const lines = $('urlInput').value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const pending = queueCounts().waiting > 0;
    const active = queueCounts().active > 0;
    $('linkCount').textContent = lines.length ? `已输入 ${lines.length} 行 · 自动去重` : '每行一个 · 支持批量粘贴';
    $('clearInput').disabled = !lines.length;
    $('addOnly').disabled = isBusy || !lines.length;
    $('startButton').disabled = isBusy || engineIsUpdating() || (!lines.length && !pending);
    $('startLabel').textContent = isBusy ? '正在处理…' : lines.length ? '添加并开始' : state.paused && pending ? '继续下载' : pending ? '开始队列' : '添加并开始';
    if ($('pauseButton').dataset.pending !== 'true') $('pauseButton').disabled = (state.paused && engineIsUpdating()) || (!active && !pending);
    $('pauseButton').replaceChildren(icon(state.paused ? 'play' : 'pause'), el('span', '', state.paused ? '继续队列' : '暂停全部'));
    if ($('clearFinished').dataset.pending !== 'true') $('clearFinished').disabled = !(state.queue?.hasFinished ?? state.jobs.some(job => finishedStatuses.has(job.status)));
    if (engineIsUpdating()) $('startLabel').textContent = '引擎更新中';
    renderUpdater(); updateChannelControls();
  }
  function feedbackFor(result) {
    const count = value => Array.isArray(value) ? value.length : Number(value || 0);
    const added = count(result?.added); const duplicates = count(result?.duplicates); const errors = count(result?.errors);
    const parts = [`已加入 ${added} 个任务`]; if (duplicates) parts.push(`跳过 ${duplicates} 个重复链接`); if (errors) parts.push(`${errors} 项未能加入`);
    let text = parts.join(' · ');
    if (Array.isArray(result?.errors) && result.errors.length) text += '\n' + result.errors.slice(0, 4).map(error => typeof error === 'string' ? error : [error.url || error.input, error.message || error.error].filter(Boolean).join('：')).join('\n');
    if (errors > 4) text += `\n另有 ${errors - 4} 项错误，请检查输入内容`;
    $('inputFeedback').textContent = text; $('inputFeedback').hidden = false; $('inputFeedback').classList.toggle('has-errors', errors > 0);
    return { added, duplicates, errors };
  }
  async function submit(startAfter) {
    if (isBusy) return;
    if (startAfter && engineIsUpdating()) { toast('引擎更新中，请完成后再开始下载'); return; }
    const text = $('urlInput').value.trim();
    if (!text && !startAfter) { $('urlInput').focus(); return; }
    isBusy = true; updateControls();
    try {
      await persistSettings();
      let result;
      if (text) { result = await api.add(text, getSettings()); const counts = feedbackFor(result); if (counts.added > 0 || (counts.duplicates > 0 && !counts.errors)) $('urlInput').value = ''; if (counts.added) toast(`已加入 ${counts.added} 个下载任务`); }
      await refreshState();
      if (startAfter && queueCounts().waiting > 0) { await api.start(); await refreshState(); toast('下载队列已开始'); }
    } catch (error) { toast(errorMessage(error), 'error'); }
    finally { isBusy = false; updateControls(); }
  }
  async function chooseOutput(button) {
    await operation(button, async () => { const path = await api.chooseOutput(); if (path) { $('outputDir').value = path; await persistSettings(); toast('保存位置已更新'); } });
  }
  function showDialog(id) { for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close(); if (!$(id).open) $(id).showModal(); }
  function renderBackgrounds() {
    const background = state.backgrounds.find(item => /^background\.mp4$/i.test(item.name));
    const candidate = background?.url || '';
    // Migrate old empty/example selections; retain the separate motion preference.
    backgroundChoice = candidate && candidate !== failedBackgroundUrl ? candidate : '';
    if (candidate) savePreference('cinder.background', candidate);
    const select = $('backgroundSelect');
    const label = candidate ? 'background.mp4' : '未找到 background.mp4';
    if (select.options.length !== 1 || select.options[0].value !== candidate || select.options[0].textContent !== label) {
      const option = el('option', '', label); option.value = candidate; select.replaceChildren(option);
    }
    select.disabled = !candidate; select.value = candidate;
    $('backgroundCount').textContent = preview ? '预览模式没有连接本地文件系统。请在桌面应用中使用此功能。' : !candidate ? '打开背景目录，放入 background.mp4 后刷新。' : failedBackgroundUrl === candidate ? 'background.mp4 无法播放，当前显示静态背景。替换文件后点击刷新。' : 'background.mp4 将自动静音循环播放；替换同名文件后点击刷新。';
    applyBackground();
  }
  function applyBackground() {
    const video = $('backgroundVideo'); const animate = motionEnabled && !reducedMotion.matches;
    document.body.classList.toggle('motion-disabled', !animate || !backgroundChoice); $('motionToggle').checked = motionEnabled;
    if (backgroundChoice) {
      if (video.getAttribute('src') !== backgroundChoice) { video.src = backgroundChoice; video.load(); }
      video.classList.toggle('has-background', animate);
      if (animate && document.visibilityState !== 'hidden') video.play().catch(() => {}); else video.pause();
    } else { video.pause(); video.removeAttribute('src'); video.classList.remove('has-background'); }
  }
  function createPreviewBridge() {
    let snapshot = { settings: { outputDir: '', quality: 'best', concurrency: 2 }, jobs: [], paused: false, engine: { ready: false }, backgrounds: [], appVersion: '1.0.5 · PREVIEW' };
    const notify = new Set();
    const emit = () => { const data = structuredClone(snapshot); notify.forEach(callback => callback(data)); return data; };
    const unavailable = () => { throw new Error('界面预览未连接本地下载引擎，请在桌面应用中使用此功能'); };
    return {
      async checkUpdates() { unavailable(); }, async installUpdate() { unavailable(); },
      async scanChannel() { unavailable(); }, async cancelChannelScan() { unavailable(); }, async downloadChannel() { unavailable(); },
      async getChannelEntries() { unavailable(); },
      async getState() { return structuredClone(snapshot); }, onState(callback) { notify.add(callback); return () => notify.delete(callback); },
      async updateSettings(settings) { snapshot.settings = { ...snapshot.settings, ...settings }; return emit(); },
      async add(text) {
        const result = { added: 0, duplicates: 0, errors: [] };
        const urls = text.split(/\r?\n/).map(url => url.trim()).filter(Boolean);
        for (const url of urls) {
          let parsed; try { parsed = new URL(url); if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) throw new Error('协议不支持'); } catch { result.errors.push({ url, message: '请输入不含登录信息的完整 HTTPS 视频链接' }); continue; }
          if (snapshot.jobs.some(job => job.url === url)) { result.duplicates++; continue; }
          snapshot.jobs.push({ id: `preview-${Date.now()}-${snapshot.jobs.length}`, url, title: '预览队列 · 尚未连接下载引擎', platform: parsed.hostname, status: 'queued', progress: 0, createdAt: Date.now() }); result.added++;
        }
        emit(); return result;
      },
      async start() { unavailable(); }, async pause() { snapshot.paused = true; emit(); },
      async cancel(id) { snapshot.jobs = snapshot.jobs.map(job => job.id === id ? { ...job, status: 'cancelled' } : job); emit(); },
      async retry(id) { snapshot.jobs = snapshot.jobs.map(job => job.id === id ? { ...job, status: 'queued', error: undefined } : job); emit(); },
      async remove(id) { snapshot.jobs = snapshot.jobs.filter(job => job.id !== id); emit(); },
      async clearFinished() { snapshot.jobs = snapshot.jobs.filter(job => !finishedStatuses.has(job.status)); emit(); },
      async chooseOutput() { unavailable(); }, async openOutput() { unavailable(); }, async showFile() { unavailable(); }, async openBackgrounds() { unavailable(); }, async refreshBackgrounds() { return []; }
    };
  }

  $('checkEngineUpdate').addEventListener('click', () => runUpdateAction('check'));
  $('installEngineUpdate').addEventListener('click', () => runUpdateAction('install'));
  $('scanChannel').addEventListener('click', scanChannel);
  $('cancelChannelScan').addEventListener('click', cancelChannelScan);
  $('downloadChannel').addEventListener('click', downloadChannel);
  $('channelSearchButton').addEventListener('click', () => loadChannelEntries(1, $('channelSearch').value.trim()));
  $('channelSearch').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void loadChannelEntries(1, $('channelSearch').value.trim()); } });
  $('channelEntryPrevious').addEventListener('click', () => loadChannelEntries(channelEntries.page - 1));
  $('channelEntryNext').addEventListener('click', () => loadChannelEntries(channelEntries.page + 1));
  $('channelSelectPage').addEventListener('click', () => {
    if (!channelSelectionEditable() || channelListLoading) return;
    const checked = !channelEntries.entries.every(entry => channelEntrySelected(entry.id));
    for (const entry of channelEntries.entries) setChannelEntrySelected(entry.id, checked);
    renderChannelSelection(); updateChannelControls();
  });
  $('channelSelectAll').addEventListener('click', () => { if (!channelSelectionEditable()) return; clearChannelSelection(); allChannelSelected = true; renderChannelSelection(); updateChannelControls(); });
  $('channelClearSelection').addEventListener('click', () => { if (!channelSelectionEditable()) return; clearChannelSelection(); renderChannelSelection(); updateChannelControls(); });
  function channelInputChanged() { channelInputsInitialized = true; channelInputDirty = state.channel.status !== 'idle'; channelFeedback = ''; channelFeedbackError = false; updateControls(); renderChannel(); }
  $('channelUrl').addEventListener('input', channelInputChanged);
  $('channelUrl').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); scanChannel(); } });
  for (const box of channelTypeInputs()) box.addEventListener('change', channelInputChanged);
  $('queuePrevious').addEventListener('click', () => changeQueueView(page - 1));
  $('queueNext').addEventListener('click', () => changeQueueView(page + 1));
  $('previewBanner').hidden = !preview;
  $('urlInput').addEventListener('input', updateControls);
  $('urlInput').addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); submit(true); } });
  $('clearInput').addEventListener('click', () => { $('urlInput').value = ''; $('inputFeedback').hidden = true; updateControls(); $('urlInput').focus(); });
  $('addOnly').addEventListener('click', () => submit(false)); $('startButton').addEventListener('click', () => submit(true));
  $('chooseOutput').addEventListener('click', () => chooseOutput($('chooseOutput')));
  $('channelChooseOutput').addEventListener('click', () => chooseOutput($('channelChooseOutput')));
  $('settingsChooseOutput').addEventListener('click', () => chooseOutput($('settingsChooseOutput')));
  for (const id of ['quality', 'channelQuality']) $(id).addEventListener('change', async () => {
    const edit = ++qualityEditVersion;
    pendingQuality = $(id).value;
    $('quality').value = pendingQuality; $('channelQuality').value = pendingQuality;
    updateChannelControls();
    try { await persistSettings(); if (edit === qualityEditVersion) { pendingQuality = null; await refreshState(); } }
    catch (error) { if (edit === qualityEditVersion) pendingQuality = null; toast(errorMessage(error), 'error'); }
  });
  $('concurrency').addEventListener('change', () => { persistSettings().then(refreshState).catch(error => toast(errorMessage(error), 'error')); });
  $('pauseButton').addEventListener('click', () => operation($('pauseButton'), async () => { const resume = state.paused; if (resume && engineIsUpdating()) return; if (resume) { await persistSettings(); await api.start(); } else await api.pause(); toast(resume ? '已继续下载队列' : '已暂停下载队列'); }));
  $('clearFinished').addEventListener('click', () => operation($('clearFinished'), () => api.clearFinished(), '已清理所有已结束的记录，下载文件保留'));
  for (const button of document.querySelectorAll('[data-filter]')) button.addEventListener('click', () => changeQueueView(1, button.dataset.filter));
  $('navDownloads').addEventListener('click', () => { for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close(); $('urlInput').focus(); window.scrollTo({ top: 0, behavior: motionEnabled && !reducedMotion.matches ? 'smooth' : 'instant' }); });
  $('navFiles').addEventListener('click', () => operation($('navFiles'), () => api.openOutput()));
  $('navSettings').addEventListener('click', () => showDialog('settingsDialog'));
  for (const id of ['navHelp', 'topHelp']) $(id).addEventListener('click', () => showDialog('helpDialog'));
  for (const id of ['navBackground', 'ambienceCard', 'settingsBackground']) $(id).addEventListener('click', () => { showDialog('backgroundDialog'); operation(null, async () => { const backgrounds = await api.refreshBackgrounds(); if (Array.isArray(backgrounds)) state.backgrounds = backgrounds; }); });
  for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
  $('backgroundSelect').addEventListener('change', renderBackgrounds);
  $('refreshBackgrounds').addEventListener('click', () => operation($('refreshBackgrounds'), async () => { failedBackgroundUrl = ''; backgroundChoice = ''; applyBackground(); const backgrounds = await api.refreshBackgrounds(); if (Array.isArray(backgrounds)) state.backgrounds = backgrounds; }, '背景已刷新'));
  $('openBackgrounds').addEventListener('click', () => operation($('openBackgrounds'), () => api.openBackgrounds()));
  $('motionToggle').addEventListener('change', () => { motionEnabled = $('motionToggle').checked; savePreference('cinder.motion', String(motionEnabled)); applyBackground(); });
  reducedMotion.addEventListener('change', applyBackground); document.addEventListener('visibilitychange', applyBackground);
  $('backgroundVideo').addEventListener('error', () => { if (backgroundChoice) { failedBackgroundUrl = backgroundChoice; backgroundChoice = ''; renderBackgrounds(); toast('background.mp4 无法播放，已显示静态背景；替换文件后请刷新', 'error'); } });
  if (typeof api.onState === 'function') { const unsubscribe = api.onState(applyState); if (typeof unsubscribe === 'function') window.addEventListener('beforeunload', unsubscribe, { once: true }); }
  applyBackground(); updateControls();
  refreshState().catch(error => { $('engineReady').textContent = '连接失败'; $('engineNote').textContent = errorMessage(error); toast(`无法连接下载服务：${errorMessage(error)}`, 'error'); });
})();
