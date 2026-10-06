'use strict';
const path = require('node:path');
const { createHash } = require('node:crypto');
const { validateSettings } = require('./core');
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const MAX_SELECTION = 100000;

function selectedEntries(scanner, scan, selection) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) throw new Error('请先勾选要下载的视频，或明确选择全部视频');
  if (Object.keys(selection).some(key => !['scanId', 'ids', 'all', 'excludedIds'].includes(key))) throw new Error('视频选择参数无效');
  if (typeof selection.scanId !== 'string' || !selection.scanId || selection.scanId !== scan.scanId) {
    const error = new Error('频道扫描结果已更新，请刷新列表后重新选择视频');
    error.code = 'STALE_SCAN';
    throw error;
  }
  const all = Object.hasOwn(selection, 'all');
  const explicitIds = Object.hasOwn(selection, 'ids');
  if ((all && (selection.all !== true || explicitIds)) || (!all && (!explicitIds || Object.hasOwn(selection, 'excludedIds')))) throw new Error('请明确选择视频，不能同时指定全部和单独视频');
  const ids = all ? (Object.hasOwn(selection, 'excludedIds') ? selection.excludedIds : []) : selection.ids;
  if (!Array.isArray(ids) || ids.length > MAX_SELECTION || (!all && ids.length === 0)) throw new Error('请选择 1 到 100,000 个视频');
  const known = new Set(scanner.entries.map(entry => entry.id));
  const chosen = new Set();
  for (const id of ids) {
    if (typeof id !== 'string' || !VIDEO_ID.test(id) || !known.has(id)) throw new Error('选择中包含当前扫描结果以外的视频，请刷新列表后重新选择');
    chosen.add(id);
  }
  // Capture both membership and entry values before updateSettings/onChange or
  // the first async history check can allow a newer scan to replace the results.
  const entries = scanner.entries.filter(entry => all ? !chosen.has(entry.id) : chosen.has(entry.id)).map(entry => ({ ...entry }));
  if (!entries.length || entries.length > MAX_SELECTION) throw new Error('请选择 1 到 100,000 个视频');
  return entries;
}

function channelDirectory(base, scan) {
  // The stable ID keeps the same destination if the channel changes its title.
  const identity = /^UC[\w-]{22}$/.test(scan.channelId || '') ? scan.channelId
    : createHash('sha256').update(scan.url).digest('hex').slice(0, 16);
  return path.join(base, `YouTube-${identity}`);
}

class ChannelImporter {
  constructor({ manager, scanner, onChange = () => {} }) {
    this.manager = manager;
    this.scanner = scanner;
    this.onChange = onChange;
    this.busy = false;
    this.message = '';
    this.closed = false;
    this.pending = null;
    this.autoStart = true;
  }

  start(settings, selection) {
    if (this.closed) throw new Error('应用正在退出');
    if (this.busy) throw new Error('正在加入频道视频，请稍候');
    this.manager._assertReady();
    this.manager._assertEngineNotUpdating();
    if (!this.manager.engine.ready) throw new Error(this.manager.engine.error || '下载引擎尚未就绪');
    const scan = this.scanner.snapshot();
    if (this.scanner.busy || this.scanner.unsafeStop || scan.status === 'scanning') throw new Error('请先完成或停止频道扫描');
    if (!['ready', 'error', 'cancelled', 'interrupted'].includes(scan.status) || !this.scanner.entries.length) throw new Error('请先扫描频道，找到可下载的视频');
    const entries = selectedEntries(this.scanner, scan, selection);
    const selected = validateSettings(settings, this.manager.settings);
    this.manager.updateSettings(selected);
    const destination = channelDirectory(selected.outputDir, scan);
    const jobSettings = { ...selected, outputDir: destination };
    this.busy = true;
    this.autoStart = true;
    this.message = `正在分批加入已选的 ${entries.length} 个频道视频…`;
    this.onChange();
    this.pending = this._import(jobSettings, scan, entries).finally(() => { this.busy = false; this.onChange(); });
    return this.pending;
  }

  async _import(settings, scan, entries) {
    const result = { selected: entries.length, added: 0, duplicates: 0, historySkipped: 0, errors: [], remaining: 0, outputDir: settings.outputDir, started: false };
    let cursor = 0;
    try {
      while (cursor < entries.length && !this.closed) {
        const batch = entries.slice(cursor, cursor + 100);
        const fresh = [];
        for (const entry of batch) {
          if (await this.manager.wasDownloaded(entry.url, settings)) result.historySkipped++;
          else fresh.push(entry);
        }
        const added = this.manager.addChannelBatch(fresh, settings, scan.channelId || scan.url);
        result.added += added.added;
        result.duplicates += added.duplicates;
        cursor += batch.length;
        this.message = `已检查 ${cursor} / ${entries.length} · 新增 ${result.added} · 已下载 ${result.historySkipped} · 队列重复 ${result.duplicates}`;
        this.onChange();
        // Keep cancellation, window rendering and shutdown responsive for large channels.
        await new Promise(resolve => setImmediate(resolve));
      }
      result.remaining = entries.length - cursor;
      await this.manager._persist();
      if (this.manager.engine.persistenceError) throw new Error(this.manager.engine.persistenceError);
      if (!this.closed && this.autoStart) result.started = this.manager.startSelected(entries, settings) > 0;
      this.message = `新增 ${result.added} · 已下载跳过 ${result.historySkipped} · 队列重复 ${result.duplicates}${result.remaining ? ` · 尚有 ${result.remaining} 条未加入` : ''} · 保存至 ${settings.outputDir}`;
    } catch (error) {
      result.remaining = entries.length - cursor;
      result.errors.push({ error: error.message });
      await this.manager._persist();
      this.message = `${error.message}；已加入 ${result.added}，尚有 ${result.remaining} 条未处理。扫描结果已保留，可再次导入。`;
    }
    this.onChange();
    return result;
  }

  suppressAutostart() { this.autoStart = false; }
  async shutdown() { this.closed = true; if (this.pending) await this.pending; }
}

module.exports = { ChannelImporter, channelDirectory };
