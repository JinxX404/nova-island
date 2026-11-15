'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fileURLToPath, pathToFileURL } = require('url');
const WidgetModel = require('./widgets/model');

const STORE_VERSION = 1;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const copy = (value) => JSON.parse(JSON.stringify(value));
const errorMessage = (error) => error && typeof error.message === 'string' ? error.message : String(error);

let activeService = null;

function start(options = {}) {
  if (activeService) return;
  const electron = options.electron || require('electron');
  const service = createService(electron, options);
  activeService = service;
  try {
    service.start();
  } catch (error) {
    activeService = null;
    service.stop();
    throw error;
  }
}

function updateFeatures(features) {
  if (activeService) activeService.updateFeatures(features);
}

function stop() {
  if (!activeService) return Promise.resolve();
  const service = activeService;
  return service.stop().finally(() => {
    if (activeService === service) activeService = null;
  });
}

function createService(electron, options) {
  const {
    app, BrowserWindow, ipcMain, screen, dialog, shell, nativeImage, Menu,
  } = electron;
  if (!app || !BrowserWindow || !ipcMain || !screen || !dialog || !shell || !nativeImage) {
    throw new TypeError('widgets service requires Electron app, BrowserWindow, ipcMain, screen, dialog, shell, and nativeImage');
  }
  const rootDir = __dirname;
  const widgetsPage = path.join(rootDir, 'widgets', 'index.html');
  const widgetsPreload = path.join(rootDir, 'widgets', 'preload.js');
  const prefsPage = path.join(rootDir, 'prefs', 'index.html');
  const dataPath = path.join(app.getPath('userData'), 'widgets.json');

  let store = { version: STORE_VERSION, widgets: [] };
  let storeError = null;
  let featureState = {};
  let active = false;
  let stopping = false;
  let stopped = false;
  let pendingWrites = 0;
  let queue = Promise.resolve();
  let startupReady = Promise.resolve();
  let stopPromise = null;
  let appQuitAfterStop = false;
  let tempCounter = 0;
  const windows = new Map();
  const ownerByContents = new Map();
  const pickedApps = new Map();
  const timers = new Set();
  const ipcHandlers = new Map();
  const ipcListeners = new Map();
  const screenListeners = [];

  function logError(context, error) {
    try { console.error(`[widgets] ${context}: ${errorMessage(error)}`); } catch (_) {}
  }

  function snapshot() {
    return copy(store);
  }

  function getFeatures() {
    try {
      const result = typeof options.getFeatures === 'function' ? options.getFeatures() : featureState;
      if (isObject(result)) featureState = copy(result);
    } catch (error) {
      logError('could not read features', error);
    }
    return copy(featureState);
  }

  function setFeatures(features) {
    featureState = isObject(features) ? copy(features) : {};
    for (const [id, record] of windows) sendState(id, record);
  }

  function notifyPreferences() {
    if (typeof options.notifyPrefs !== 'function' || storeError) return;
    try { options.notifyPrefs(snapshot()); } catch (error) { logError('could not notify preferences', error); }
  }

  function recordError() {
    if (storeError) throw new Error(storeError);
  }

  function loadStore() {
    let contents;
    try {
      contents = fs.readFileSync(dataPath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      storeError = `Could not read widgets.json: ${errorMessage(error)}`;
      logError('could not read widgets.json; preserving it read-only', error);
      return;
    }

    let raw;
    try {
      raw = JSON.parse(contents);
    } catch (error) {
      storeError = `widgets.json is not valid JSON: ${errorMessage(error)}`;
      logError('widgets.json is corrupt; preserving it read-only', error);
      return;
    }

    if (isObject(raw) && Number.isInteger(raw.version) && raw.version > STORE_VERSION) {
      storeError = `widgets.json version ${raw.version} is newer than supported version ${STORE_VERSION}`;
      logError(storeError, new Error('future widget store version'));
      return;
    }

    try {
      store = WidgetModel.normalizeStore(raw);
    } catch (error) {
      storeError = `Could not load widgets.json: ${errorMessage(error)}`;
      logError('widgets.json is unsupported or invalid; preserving it read-only', error);
    }
  }

  function appKey(target) {
    return String(target).replace(/\//g, '\\').toLowerCase();
  }

  function appTargetsIn(widgets) {
    const targets = new Set();
    for (const widget of widgets) {
      if (widget.kind !== 'links') continue;
      for (const item of widget.content.items) {
        if (item.type === 'app') targets.add(appKey(item.target));
      }
    }
    return targets;
  }

  function isApprovedApp(target) {
    const key = appKey(target);
    return pickedApps.has(key) || appTargetsIn(store.widgets).has(key);
  }

  function validateAppTarget(target) {
    try {
      WidgetModel.normalizeWidget({
        kind: 'links',
        content: {
          items: [{ id: 'approved-app-check', label: 'App', icon: '', type: 'app', target }],
        },
      });
    } catch (_) {
      throw new TypeError('App links must point to an absolute .exe or .lnk file');
    }
    return target;
  }

  function validateWebsiteTarget(target) {
    if (typeof target !== 'string' || !target || /[\u0000-\u0020\u007f\\]/.test(target) || !/^https?:\/\//i.test(target)) {
      throw new TypeError('Website links must use a valid HTTP or HTTPS URL');
    }
    let parsed;
    try { parsed = new URL(target); } catch (_) { throw new TypeError('Website link is not a valid URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
      throw new TypeError('Website links must use a valid HTTP or HTTPS URL');
    }
    return target;
  }

  function validateWidgetApps(widget) {
    if (widget.kind !== 'links') return;
    for (const item of widget.content.items) {
      if (item.type === 'app') {
        validateAppTarget(item.target);
        if (!isApprovedApp(item.target)) throw new Error('Choose this app with the app picker before saving it');
      } else {
        validateWebsiteTarget(item.target);
      }
    }
  }

  function workAreaFor(bounds) {
    const safeBounds = isObject(bounds) ? bounds : { x: 0, y: 0, width: 320, height: 180 };
    try {
      const display = screen.getDisplayMatching(safeBounds);
      if (display && isObject(display.workArea)) return display.workArea;
    } catch (_) {}
    try {
      const display = screen.getPrimaryDisplay();
      if (display && isObject(display.workArea)) return display.workArea;
    } catch (_) {}
    return { x: 0, y: 0, width: 1920, height: 1080 };
  }

  function clampedBounds(widget, requested) {
    const area = workAreaFor(requested || {
      x: widget.position.x,
      y: widget.position.y,
      width: widget.layout.width,
      height: widget.layout.height,
    });
    return WidgetModel.clampBounds(requested || {
      x: widget.position.x,
      y: widget.position.y,
      width: widget.layout.width,
      height: widget.layout.height,
    }, area);
  }

  function clampWidgetPosition(widget) {
    const bounds = clampedBounds(widget);
    const width = bounds.width >= 180 ? Math.min(widget.layout.width, bounds.width) : widget.layout.width;
    const height = bounds.height >= 64 ? Math.min(widget.layout.height, bounds.height) : widget.layout.height;
    if (widget.position.x === bounds.x && widget.position.y === bounds.y && width === widget.layout.width && height === widget.layout.height) return widget;
    return WidgetModel.normalizeWidget({
      ...widget,
      position: { x: bounds.x, y: bounds.y },
      layout: { ...widget.layout, width, height },
    });
  }

  function windowArea(id) {
    const widget = store.widgets.find((item) => item.id === id);
    if (!widget) return workAreaFor({ x: 0, y: 0, width: 320, height: 180 });
    return workAreaFor(clampedBounds(widget));
  }

  function persistStore(nextStore) {
    recordError();
    const normalized = WidgetModel.normalizeStore(nextStore);
    const json = `${JSON.stringify(normalized, null, 2)}\n`;
    const directory = path.dirname(dataPath);
    const tempPath = `${dataPath}.${process.pid}.${++tempCounter}.${crypto.randomBytes(5).toString('hex')}.tmp`;
    return fs.promises.mkdir(directory, { recursive: true })
      .then(() => fs.promises.writeFile(tempPath, json, { encoding: 'utf8', flag: 'wx' }))
      .then(() => fs.promises.rename(tempPath, dataPath))
      .catch(async (error) => {
        try { await fs.promises.unlink(tempPath); } catch (_) {}
        throw error;
      });
  }

  function safeCloseWindow(id, record) {
    const current = windows.get(id);
    if (current !== record) return;
    if (record.closeTimer) {
      clearTimeout(record.closeTimer);
      timers.delete(record.closeTimer);
      record.closeTimer = null;
    }
    windows.delete(id);
    ownerByContents.delete(record.contents);
    record.closing = true;
    try {
      if (!record.win.isDestroyed()) record.win.close();
    } catch (error) {
      logError(`could not close widget ${id}`, error);
    }
  }

  function sendState(id, record) {
    const widget = store.widgets.find((item) => item.id === id);
    if (!widget || !record || record.win.isDestroyed()) return;
    const bounds = record.win.getBounds();
    const payload = {
      widget: copy(widget),
      features: copy(featureState),
      workArea: copy(workAreaFor(bounds)),
      editing: !!record.editing && !widget.locked,
      inlineEditing: !!record.inlineEditing,
    };
    try { record.win.webContents.send('widget-state', payload); } catch (error) { logError(`could not update widget ${id}`, error); }
  }

  function reconcileWindows(optionsForReconcile = {}) {
    const deferredClose = optionsForReconcile.deferClose || new Set();
    const expected = new Set(store.widgets.filter((widget) => !widget.hidden).map((widget) => widget.id));
    for (const [id, record] of Array.from(windows.entries())) {
      if (expected.has(id)) {
        if (record.closeTimer) {
          clearTimeout(record.closeTimer);
          timers.delete(record.closeTimer);
          record.closeTimer = null;
        }
        continue;
      }
      if (deferredClose.has(id)) {
        if (!record.closeTimer) {
          const timer = setTimeout(() => {
            timers.delete(timer);
            record.closeTimer = null;
            const currentWidget = store.widgets.find((widget) => widget.id === id);
            if (!currentWidget || currentWidget.hidden) safeCloseWindow(id, record);
          }, 30);
          record.closeTimer = timer;
          timers.add(timer);
        }
      } else {
        safeCloseWindow(id, record);
      }
    }
    for (const widget of store.widgets) {
      if (widget.hidden) continue;
      let record = windows.get(widget.id);
      if (!record || record.win.isDestroyed()) {
        try { record = createWindow(widget); }
        catch (error) {
          logError(`could not create widget ${widget.id}`, error);
          continue;
        }
        if (!record) continue;
      } else {
        const bounds = record.inlineEditing ? editorBounds(widget) : clampedBounds(widget);
        try {
          const currentBounds = record.win.getBounds();
          if (!sameNativeBounds(currentBounds, bounds)) record.win.setBounds(bounds);
          applyEditMode(record, widget);
        } catch (error) {
          logError(`could not update widget ${widget.id}`, error);
        }
      }
      sendState(widget.id, record);
    }
  }

  function sameBounds(a, b) {
    return !!a && !!b && ['x', 'y', 'width', 'height'].every((key) => a[key] === b[key]);
  }

  // Windows rounds fractional display pixels back to DIPs. That rounding is not a user resize.
  function sameNativeBounds(a, b) {
    return !!a && !!b && ['x', 'y', 'width', 'height'].every((key) => Math.abs(a[key] - b[key]) <= 1);
  }

  function createWindow(widget) {
    const bounds = clampedBounds(widget);
    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      show: false,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      title: `Nova widget: ${widget.kind}`,
      webPreferences: {
        preload: widgetsPreload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    try {
      if (typeof win.setMenu === 'function') win.setMenu(null);
      if (typeof win.setMinimumSize === 'function') win.setMinimumSize(180, 64);
      if (typeof win.setResizable === 'function') win.setResizable(false);
      if (typeof win.setMovable === 'function') win.setMovable(false);
    } catch (error) {
      logError(`could not configure widget ${widget.id}`, error);
    }

    const record = { id: widget.id, win, contents: win.webContents, editing: false, inlineEditing: false, closing: false, geometryTimer: null, closeTimer: null, retryTimer: null };
    windows.set(widget.id, record);
    ownerByContents.set(win.webContents, record);
    configureNavigation(record);
    installWindowEvents(record);
    const pageUrl = pathToFileURL(widgetsPage).href;
    win.loadFile(widgetsPage, { query: { id: widget.id } }).catch((error) => {
      logError(`could not load widget ${widget.id}`, error);
      if (windows.get(widget.id) === record) safeCloseWindow(widget.id, record);
    });
    win.once('ready-to-show', () => {
      if (windows.get(widget.id) !== record || win.isDestroyed()) return;
      try { win.showInactive(); } catch (error) { logError(`could not show widget ${widget.id}`, error); }
    });
    record.expectedUrl = `${pageUrl}?id=${encodeURIComponent(widget.id)}`;
    return record;
  }

  function configureNavigation(record) {
    const contents = record.win.webContents;
    try {
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.on('did-start-loading', () => {
        if (record.inlineEditing) void updateInlineEditing(record, false);
      });
      contents.on('will-navigate', (event, url) => {
        if (url === record.expectedUrl) return;
        event.preventDefault();
      });
      contents.on('render-process-gone', (_event, details) => {
        logError(`renderer for widget ${record.id} stopped`, new Error(details && details.reason ? details.reason : 'unknown reason'));
        scheduleWindowRecovery(record);
      });
      contents.on('did-fail-load', (_event, errorCode, description, _url, isMainFrame) => {
        if (isMainFrame && errorCode !== -3) logError(`widget ${record.id} failed to load`, new Error(`${errorCode}: ${description}`));
      });
    } catch (error) {
      logError(`could not secure widget ${record.id} navigation`, error);
    }
  }

  function installWindowEvents(record) {
    const { win, id } = record;
    win.on('close', (event) => {
      if (record.closing || stopping || !active) return;
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      void desktopAction(record, 'hide').then((result) => {
        if (!result.ok) logError(`could not hide widget ${id}`, new Error(result.error));
      }).catch((error) => logError(`could not hide widget ${id}`, error));
    });
    win.on('closed', () => {
      ownerByContents.delete(record.contents);
      if (windows.get(id) === record) windows.delete(id);
    });
    win.on('move', () => onNativeGeometry(record));
    win.on('resize', () => onNativeGeometry(record));
  }

  function scheduleWindowRecovery(record) {
    if (record.retryTimer || stopping || !active) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      record.retryTimer = null;
      if (windows.get(record.id) !== record || stopping) return;
      const current = store.widgets.find((widget) => widget.id === record.id);
      if (!current || current.hidden) return;
      try {
        record.closing = true;
        if (!record.win.isDestroyed()) record.win.destroy();
      } catch (_) {}
      if (windows.get(record.id) === record) windows.delete(record.id);
      ownerByContents.delete(record.contents);
      if (active && !stopping) createWindow(current);
    }, 500);
    record.retryTimer = timer;
    timers.add(timer);
  }

  function applyEditMode(record, widget) {
    const editing = !!record.editing && !widget.locked;
    record.editing = editing;
    try {
      record.win.setMovable(editing && !record.inlineEditing);
      // The renderer's bounded corner grip handles resizing without native frame borders.
      record.win.setResizable(false);
    } catch (error) {
      logError(`could not change edit mode for widget ${widget.id}`, error);
    }
  }

  function isMainFrame(event) {
    return !!event && !!event.sender && !!event.senderFrame && event.senderFrame === event.sender.mainFrame;
  }

  function isPrefsSender(event) {
    if (!isMainFrame(event) || typeof options.isPrefs !== 'function') return false;
    try {
      if (options.isPrefs(event.sender) !== true) return false;
      return isExactLocalPage(event.sender, prefsPage);
    } catch (_) {
      return false;
    }
  }

  function isExactLocalPage(contents, expectedPath) {
    let url;
    try { url = new URL(contents.getURL()); } catch (_) { return false; }
    if (url.protocol !== 'file:' || url.host !== '' || url.search !== '' || url.hash !== '' || url.username || url.password) return false;
    let actualPath;
    try { actualPath = path.resolve(fileURLToPath(url)); } catch (_) { return false; }
    const expected = path.resolve(expectedPath);
    return process.platform === 'win32'
      ? actualPath.toLowerCase() === expected.toLowerCase()
      : actualPath === expected;
  }

  function prefsWindowFor(event) {
    try { return BrowserWindow.fromWebContents(event.sender); } catch (_) { return null; }
  }

  function success(widget) {
    return widget ? { ok: true, widget: copy(widget) } : { ok: true };
  }

  function failure(error) {
    return { ok: false, error: errorMessage(error) };
  }

  function transact(transform, optionsForTransaction = {}) {
    if (!active || stopping) return Promise.resolve(failure(new Error('Widget service is stopping')));
    pendingWrites += 1;
    const task = queue.then(async () => {
      recordError();
      const nextWidgets = transform(copy(store.widgets));
      const nextStore = WidgetModel.normalizeStore({ version: STORE_VERSION, widgets: nextWidgets });
      if (JSON.stringify(nextStore) === JSON.stringify(store)) return nextStore;
      await persistStore(nextStore);
      store = nextStore;
      reconcileWindows(optionsForTransaction);
      notifyPreferences();
      return nextStore;
    });
    queue = task.then(() => undefined, () => undefined);
    return task.then((nextStore) => ({ ok: true, store: copy(nextStore) })).catch((error) => failure(error)).finally(() => {
      pendingWrites = Math.max(0, pendingWrites - 1);
    });
  }

  function uniqueId(existing) {
    const ids = new Set(existing.map((widget) => widget.id));
    let id;
    do { id = `widget-${crypto.randomUUID()}`; } while (ids.has(id));
    return id;
  }

  function saveWidget(raw) {
    if (!isObject(raw)) return Promise.resolve(failure(new TypeError('Widget must be an object')));
    let incoming;
    let savedId;
    try { incoming = WidgetModel.normalizeWidget(raw); } catch (error) { return Promise.resolve(failure(error)); }
    savedId = incoming.id;
    return transact((widgets) => {
      const currentIndex = widgets.findIndex((widget) => widget.id === incoming.id);
      if (currentIndex < 0) {
        if (widgets.length >= WidgetModel.MAX_WIDGETS) throw new RangeError(`A maximum of ${WidgetModel.MAX_WIDGETS} widgets is allowed`);
        incoming = WidgetModel.normalizeWidget({ ...incoming, id: uniqueId(widgets) });
        savedId = incoming.id;
        incoming = clampWidgetPosition(incoming);
        validateWidgetApps(incoming);
        widgets.push(incoming);
      } else {
        const current = widgets[currentIndex];
        if (current.locked && raw.locked !== false) {
          incoming = WidgetModel.normalizeWidget({
            ...incoming,
            locked: true,
            position: current.position,
            layout: current.layout,
          });
        }
        incoming = clampWidgetPosition(incoming);
        validateWidgetApps(incoming);
        widgets[currentIndex] = incoming;
      }
      return widgets;
    }).then((result) => result.ok ? success(result.store.widgets.find((widget) => widget.id === savedId)) : result);
  }

  function applyAction(widgets, id, action) {
    if (typeof id !== 'string' || id.length > 80) throw new TypeError('Widget id is invalid');
    const index = widgets.findIndex((widget) => widget.id === id);
    if (index < 0) throw new Error('Widget no longer exists');
    const widget = widgets[index];
    if (action === 'delete') {
      widgets.splice(index, 1);
      return { widgets, widget: null };
    }
    if (action === 'duplicate') {
      if (widgets.length >= WidgetModel.MAX_WIDGETS) throw new RangeError(`A maximum of ${WidgetModel.MAX_WIDGETS} widgets is allowed`);
      const duplicate = WidgetModel.normalizeWidget({
        ...widget,
        id: uniqueId(widgets),
        hidden: false,
        locked: false,
        position: { x: widget.position.x + 24, y: widget.position.y + 24 },
      });
      const boundedDuplicate = clampWidgetPosition(duplicate);
      widgets.push(boundedDuplicate);
      return { widgets, widget: boundedDuplicate };
    }
    if (action === 'hide') widget.hidden = true;
    else if (action === 'show') {
      widget.hidden = false;
      widgets[index] = clampWidgetPosition(widget);
      return { widgets, widget: widgets[index] };
    }
    else if (action === 'lock') widget.locked = true;
    else if (action === 'unlock') widget.locked = false;
    else throw new Error('Widget action is not supported');
    return { widgets, widget };
  }

  function prefsAction(id, action) {
    let resultWidget = null;
    return transact((widgets) => {
      const result = applyAction(widgets, id, action);
      resultWidget = result.widget;
      return result.widgets;
    }).then((result) => result.ok ? (resultWidget ? success(resultWidget) : { ok: true }) : result);
  }

  function desktopAction(record, action) {
    const widget = store.widgets.find((item) => item.id === record.id);
    if (!widget) return Promise.resolve(failure(new Error('Widget no longer exists')));
    if (widget.hidden) return Promise.resolve(failure(new Error('Widget is hidden')));
    if (action === 'menu') return openWidgetMenu(record, widget);
    if (action === 'edit') {
      try {
        if (typeof options.openSettings !== 'function') throw new Error('Settings window is unavailable');
        options.openSettings(record.id);
        return Promise.resolve({ ok: true });
      } catch (error) {
        return Promise.resolve(failure(error));
      }
    }
    if (!['hide', 'duplicate', 'lock', 'unlock', 'delete'].includes(action)) {
      return Promise.resolve(failure(new Error('Widget action is not supported')));
    }
    let resultWidget = null;
    const deferClose = new Set(['hide', 'delete'].includes(action) ? [record.id] : []);
    return transact((widgets) => {
      const result = applyAction(widgets, record.id, action);
      resultWidget = result.widget;
      return result.widgets;
    }, { deferClose }).then((result) => result.ok ? (resultWidget ? success(resultWidget) : { ok: true }) : result);
  }

  function openWidgetMenu(record, widget) {
    if (!Menu || record.inlineEditing) return Promise.resolve(failure(new Error('Finish editing content before opening the menu')));
    return new Promise((resolve) => {
      let selected;
      const item = (label, action, extra = {}) => ({ label, ...extra, click: () => { selected = action; } });
      const menu = Menu.buildFromTemplate([
        item('Edit content', 'inline-edit'),
        item('Appearance and layout…', 'edit'),
        { type: 'separator' },
        item('Move with keyboard', 'keyboard-move', { enabled: !widget.locked }),
        item('Duplicate', 'duplicate'),
        item(widget.locked ? 'Unlock position' : 'Lock position', widget.locked ? 'unlock' : 'lock'),
        item('Hide', 'hide'),
        { type: 'separator' },
        item('Remove widget', 'delete'),
      ]);
      menu.popup({ window: record.win, callback: () => {
        if (selected === 'inline-edit' || selected === 'keyboard-move') resolve({ ok: true, action: selected });
        else if (selected) void desktopAction(record, selected).then(resolve);
        else resolve({ ok: true });
      } });
    });
  }

  function updateEditing(record, value) {
    if (typeof value !== 'boolean') return failure(new TypeError('Editing state must be boolean'));
    const widget = store.widgets.find((item) => item.id === record.id);
    if (!widget) return failure(new Error('Widget no longer exists'));
    if (widget.hidden) return failure(new Error('Widget is hidden'));
    if (widget.locked && value) return failure(new Error('Unlock this widget before editing its geometry'));
    record.editing = value && !widget.locked;
    applyEditMode(record, widget);
    sendState(record.id, record);
    return { ok: true, editing: record.editing };
  }

  function editorBounds(widget) {
    const bounds = clampedBounds(widget);
    return clampedBounds(widget, { ...bounds, width: Math.max(320, bounds.width), height: 500 });
  }

  async function updateInlineEditing(record, value) {
    if (typeof value !== 'boolean') return failure(new TypeError('Editor state must be boolean'));
    try {
      recordError();
      if (value && record.geometryTimer) {
        clearTimeout(record.geometryTimer);
        timers.delete(record.geometryTimer);
        record.geometryTimer = null;
        await persistNativeGeometry(record);
      }
      await queue;
      const widget = store.widgets.find((item) => item.id === record.id);
      if (!widget || widget.hidden || record.win.isDestroyed()) throw new Error('Widget is no longer visible');
      record.inlineEditing = value;
      record.win.setBounds(value ? editorBounds(widget) : clampedBounds(widget));
      applyEditMode(record, widget);
      sendState(record.id, record);
      return { ok: true };
    } catch (error) { return failure(error); }
  }

  function updateContent(record, raw) {
    if (!isObject(raw)) return Promise.resolve(failure(new TypeError('Content must be an object')));
    const content = copy(raw);
    return transact((widgets) => {
      const index = widgets.findIndex((item) => item.id === record.id);
      if (index < 0 || widgets[index].hidden) throw new Error('Widget is no longer visible');
      const next = WidgetModel.normalizeWidget({ ...widgets[index], content });
      validateWidgetApps(next);
      widgets[index] = next;
      return widgets;
    }).then((result) => result.ok ? success(store.widgets.find((widget) => widget.id === record.id)) : result);
  }

  function adjustGoal(record, delta) {
    if (delta !== 1 && delta !== -1) return Promise.resolve(failure(new TypeError('Goal adjustment must be +1 or -1')));
    return transact((widgets) => {
      const widget = widgets.find((item) => item.id === record.id);
      if (!widget || widget.hidden || widget.kind !== 'goal') throw new Error('Goal is no longer visible');
      widget.content.current = Math.min(1e12, Math.max(0, widget.content.current + delta));
      return widgets;
    }).then((result) => result.ok ? success(store.widgets.find((widget) => widget.id === record.id)) : result);
  }

  function normalizeGeometryInput(record, input) {
    if (!isObject(input)) throw new TypeError('Geometry must be an object');
    const allowed = new Set(['x', 'y', 'width', 'height']);
    for (const key of Object.keys(input)) if (!allowed.has(key)) throw new TypeError(`Unknown geometry field: ${key}`);
    const widget = store.widgets.find((item) => item.id === record.id);
    if (!widget || widget.hidden) throw new Error('Widget is no longer visible');
    if (widget.locked || record.inlineEditing) throw new Error('Unlock the widget and finish editing content before moving or resizing');
    const current = record.win.getBounds();
    const requested = { ...current };
    for (const key of ['x', 'y', 'width', 'height']) {
      if (!own(input, key)) continue;
      if (typeof input[key] !== 'number' || !Number.isFinite(input[key])) throw new TypeError(`${key} must be finite`);
      requested[key] = input[key];
    }
    requested.width = Math.round(Math.min(720, Math.max(180, requested.width)));
    requested.height = Math.round(Math.min(800, Math.max(64, requested.height)));
    const bounds = clampedBounds(widget, requested);
    return { widget, bounds };
  }

  function setGeometry(record, input) {
    let normalized;
    try { normalized = normalizeGeometryInput(record, input); } catch (error) { return Promise.resolve(failure(error)); }
    const { widget, bounds } = normalized;
    return transact((widgets) => {
      const index = widgets.findIndex((item) => item.id === widget.id);
      if (index < 0) throw new Error('Widget no longer exists');
      if (widgets[index].hidden || widgets[index].locked || record.inlineEditing) throw new Error('Widget geometry can no longer be changed');
      const next = { ...widgets[index], position: { x: bounds.x, y: bounds.y }, layout: { ...widgets[index].layout } };
      if (own(input, 'width')) next.layout.width = Math.min(720, Math.max(180, bounds.width));
      if (own(input, 'height') && bounds.height !== widgets[index].layout.height) {
        next.layout.height = Math.min(800, Math.max(64, bounds.height));
        next.layout.autoHeight = false;
      }
      widgets[index] = WidgetModel.normalizeWidget(next);
      return widgets;
    }).then((result) => {
      if (result.ok) return success(store.widgets.find((item) => item.id === widget.id));
      return result;
    });
  }

  function setMeasuredHeight(record, value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return Promise.resolve(failure(new TypeError('Measured height must be finite')));
    const widget = store.widgets.find((item) => item.id === record.id);
    if (!widget || widget.hidden || !widget.layout.autoHeight || record.inlineEditing || record.win.isDestroyed()) return Promise.resolve({ ok: true });
    const currentBounds = record.win.getBounds();
    const area = workAreaFor(currentBounds);
    const available = Math.max(64, Math.min(640, area.y + area.height - currentBounds.y));
    const height = Math.round(Math.max(64, Math.min(available, value)));
    const sequence = record.measureSequence = (record.measureSequence || 0) + 1;
    if (height === currentBounds.height && pendingWrites === 0) return Promise.resolve({ ok: true });
    return transact((widgets) => {
      const current = widgets.find((item) => item.id === record.id);
      if (!current || !current.layout.autoHeight || record.inlineEditing || sequence !== record.measureSequence) return widgets;
      current.layout.height = height;
      return widgets;
    }).then((result) => {
      if (!result.ok) logError(`could not measure widget ${record.id}`, new Error(result.error));
      return result;
    });
  }

  function onNativeGeometry(record) {
    if (!active || stopping || record.closing || record.win.isDestroyed()) return;
    if (record.inlineEditing) return;
    const widget = store.widgets.find((item) => item.id === record.id);
    if (!widget) return;
    let current;
    try { current = record.win.getBounds(); } catch (_) { return; }
    const expected = clampedBounds(widget);
    if (sameNativeBounds(current, expected)) return;
    if (!record.editing || widget.locked) {
      try { record.win.setBounds(expected); } catch (_) {}
      return;
    }
    if (record.geometryTimer) {
      clearTimeout(record.geometryTimer);
      timers.delete(record.geometryTimer);
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      record.geometryTimer = null;
      void persistNativeGeometry(record);
    }, 140);
    record.geometryTimer = timer;
    timers.add(timer);
  }

  async function persistNativeGeometry(record) {
    if (!active || stopping || record.closing || record.win.isDestroyed()) return;
    const widget = store.widgets.find((item) => item.id === record.id);
    if (!widget || widget.locked || !record.editing || record.inlineEditing) return;
    try {
      const current = record.win.getBounds();
      const bounds = clampedBounds(widget, current);
      const result = await transact((widgets) => {
        const index = widgets.findIndex((item) => item.id === record.id);
        if (index < 0 || widgets[index].locked || record.inlineEditing) throw new Error('Widget geometry can no longer be changed');
        const latest = widgets[index];
        const changedHeight = bounds.height !== latest.layout.height;
        widgets[index] = WidgetModel.normalizeWidget({
          ...latest,
          position: { x: bounds.x, y: bounds.y },
          layout: {
            ...latest.layout,
            width: Math.min(720, Math.max(180, bounds.width)),
            height: Math.min(800, Math.max(64, bounds.height)),
            autoHeight: changedHeight ? false : latest.layout.autoHeight,
          },
        });
        return widgets;
      });
      if (!result.ok) {
        logError(`could not save native geometry for ${record.id}`, new Error(result.error));
        const latest = store.widgets.find((item) => item.id === record.id);
        if (latest && !record.win.isDestroyed()) record.win.setBounds(clampedBounds(latest));
        return;
      }
      const latest = store.widgets.find((item) => item.id === record.id);
      if (latest) {
        const expected = clampedBounds(latest);
        if (!sameBounds(record.win.getBounds(), expected)) record.win.setBounds(expected);
      }
    } catch (error) {
      logError(`could not save native geometry for ${record.id}`, error);
      const latest = store.widgets.find((item) => item.id === record.id);
      if (latest && !record.win.isDestroyed()) {
        try { record.win.setBounds(clampedBounds(latest)); } catch (_) {}
        sendState(record.id, record);
      }
    }
  }

  function clampForCurrentDisplays() {
    if (!active || stopping || storeError) return;
    void transact((widgets) => widgets.map(clampWidgetPosition)).then((result) => {
      if (!result.ok) logError('could not clamp widgets after a display change', new Error(result.error));
      else reconcileWindows();
    });
  }

  function screenListener(event, callback) {
    if (typeof screen.on !== 'function') return;
    screen.on(event, callback);
    screenListeners.push([event, callback]);
  }

  function registerHandler(channel, handler) {
    ipcMain.handle(channel, handler);
    ipcHandlers.set(channel, handler);
  }

  function registerListener(channel, listener) {
    ipcMain.on(channel, listener);
    ipcListeners.set(channel, listener);
  }

  function requestOwner(event) {
    if (!isMainFrame(event)) return null;
    const record = ownerByContents.get(event.sender);
    if (!record || record.win.isDestroyed() || windows.get(record.id) !== record) return null;
    return record;
  }

  function invalidPrefsResult() {
    return failure(new Error('Only the trusted Nova preferences window can use widget settings'));
  }

  function registerIpc() {
    registerHandler('widgets-get', async (event) => {
      if (!isPrefsSender(event)) throw new Error('Unauthorized widget settings request');
      await startupReady;
      recordError();
      return snapshot();
    });
    registerHandler('widgets-save', async (event, raw) => {
      if (!isPrefsSender(event)) return invalidPrefsResult();
      await startupReady;
      return saveWidget(raw);
    });
    registerHandler('widgets-action', async (event, id, action) => {
      if (!isPrefsSender(event)) return invalidPrefsResult();
      await startupReady;
      return prefsAction(id, action);
    });
    registerHandler('widgets-pick-image', (event) => {
      if (!isPrefsSender(event)) throw new Error('Unauthorized widget image picker request');
      return pickImage(event);
    });
    registerHandler('widgets-pick-app', (event) => {
      if (!isPrefsSender(event)) throw new Error('Unauthorized widget app picker request');
      return pickApp(event);
    });

    registerHandler('widget-get', (event) => {
      const record = requestOwner(event);
      if (!record) throw new Error('Unauthorized widget window');
      recordError();
      const widget = store.widgets.find((item) => item.id === record.id);
      if (!widget || widget.hidden) throw new Error('Widget is no longer visible');
      return { widget: copy(widget), features: getFeatures(), workArea: copy(windowArea(record.id)) };
    });
    registerHandler('widget-action', (event, action) => {
      const record = requestOwner(event);
      if (!record) return failure(new Error('Unauthorized widget window'));
      return desktopAction(record, action);
    });
    registerHandler('widget-editing', (event, value) => {
      const record = requestOwner(event);
      if (!record) return failure(new Error('Unauthorized widget window'));
      return updateEditing(record, value);
    });
    registerHandler('widget-editor', (event, value) => {
      const record = requestOwner(event);
      return record ? updateInlineEditing(record, value) : failure(new Error('Unauthorized widget window'));
    });
    registerHandler('widget-content', (event, value) => {
      const record = requestOwner(event);
      return record ? updateContent(record, value) : failure(new Error('Unauthorized widget window'));
    });
    registerHandler('widget-goal-step', (event, delta) => {
      const record = requestOwner(event);
      return record ? adjustGoal(record, delta) : failure(new Error('Unauthorized widget window'));
    });
    for (const [channel, kind, picker] of [['widget-pick-image', 'image', pickImage], ['widget-pick-app', 'links', pickApp]]) {
      registerHandler(channel, (event) => {
        const record = requestOwner(event);
        const widget = record && store.widgets.find((item) => item.id === record.id);
        if (!widget || widget.hidden || widget.kind !== kind) throw new Error('Unauthorized widget picker');
        return picker(event);
      });
    }
    registerHandler('widget-geometry', (event, geometry) => {
      const record = requestOwner(event);
      if (!record) return failure(new Error('Unauthorized widget window'));
      return setGeometry(record, geometry);
    });
    registerListener('widget-measure', (event, height) => {
      const record = requestOwner(event);
      if (!record) return;
      void setMeasuredHeight(record, height).catch((error) => logError(`could not measure widget ${record.id}`, error));
    });
    registerHandler('widget-open-link', (event, index) => {
      const record = requestOwner(event);
      if (!record) return failure(new Error('Unauthorized widget window'));
      return openLink(record, index);
    });
  }

  async function pickImage(event) {
    const parent = prefsWindowFor(event);
    const pickerOptions = {
      title: 'Choose a widget image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    };
    const result = parent ? await dialog.showOpenDialog(parent, pickerOptions) : await dialog.showOpenDialog(pickerOptions);
    if (!result || result.canceled || !Array.isArray(result.filePaths) || !result.filePaths[0]) return null;
    const filePath = result.filePaths[0];
    const extension = path.extname(filePath).toLowerCase();
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 4 * 1024 * 1024) throw new Error('Choose an image smaller than 4 MiB');
    const buffer = await fs.promises.readFile(filePath);
    const mime = imageMime(buffer);
    const expected = new Map([
      ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
      ['.gif', 'image/gif'], ['.webp', 'image/webp'],
    ]).get(extension);
    if (!mime || mime !== expected) throw new Error('The selected file signature does not match its image extension');
    let image;
    try { image = nativeImage.createFromBuffer(buffer); } catch (_) { image = null; }
    if (!image || typeof image.isEmpty !== 'function' || image.isEmpty()) throw new Error('The selected file is not a readable image');
    return { dataUrl: `data:${mime};base64,${buffer.toString('base64')}`, name: path.basename(filePath) };
  }

  function imageMime(buffer) {
    if (!Buffer.isBuffer(buffer)) return '';
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
    if (buffer.length >= 6 && (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a')) return 'image/gif';
    if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
    return '';
  }

  async function pickApp(event) {
    const parent = prefsWindowFor(event);
    const pickerOptions = {
      title: 'Choose an app or shortcut',
      properties: ['openFile'],
      filters: [{ name: 'Applications and shortcuts', extensions: ['exe', 'lnk'] }],
    };
    const result = parent ? await dialog.showOpenDialog(parent, pickerOptions) : await dialog.showOpenDialog(pickerOptions);
    if (!result || result.canceled || !Array.isArray(result.filePaths) || !result.filePaths[0]) return null;
    const target = validateAppTarget(path.resolve(result.filePaths[0]));
    const label = path.win32.basename(target, path.win32.extname(target));
    pickedApps.set(appKey(target), target);
    return { target, label };
  }

  async function openLink(record, index) {
    if (!Number.isInteger(index) || index < 0 || index >= 24) return failure(new Error('Link index is invalid'));
    const widget = store.widgets.find((item) => item.id === record.id);
    if (!widget || widget.hidden || widget.kind !== 'links') return failure(new Error('Link widget is unavailable'));
    const item = widget.content.items[index];
    if (!item) return failure(new Error('Link no longer exists'));
    try {
      if (item.type === 'website') {
        const target = validateWebsiteTarget(item.target);
        await shell.openExternal(target);
      } else if (item.type === 'app') {
        const target = validateAppTarget(item.target);
        if (!isApprovedApp(target)) throw new Error('This app is no longer approved');
        const result = await shell.openPath(target);
        if (result) throw new Error(result);
      }
      return { ok: true };
    } catch (error) {
      logError(`could not open widget link ${index}`, error);
      return failure(error);
    }
  }

  function startService() {
    if (active) return;
    featureState = getFeatures();
    loadStore();
    active = true;
    registerIpc();
    screenListener('display-metrics-changed', clampForCurrentDisplays);
    screenListener('display-added', clampForCurrentDisplays);
    screenListener('display-removed', clampForCurrentDisplays);
    app.on('before-quit', beforeQuit);
    startupReady = initializeLoadedStore();
  }

  function initializeLoadedStore() {
    if (storeError) return Promise.resolve();
    let nextStore;
    try {
      nextStore = WidgetModel.normalizeStore({
        version: STORE_VERSION,
        widgets: store.widgets.map((widget) => clampWidgetPosition(widget)),
      });
    } catch (error) {
      storeError = `Could not prepare widgets.json: ${errorMessage(error)}`;
      logError('could not prepare widget bounds', error);
      return Promise.resolve();
    }

    if (JSON.stringify(nextStore) === JSON.stringify(store)) {
      return Promise.resolve().then(() => {
        if (!storeError && active && !stopping) {
          reconcileWindows();
          notifyPreferences();
        }
      });
    }

    pendingWrites += 1;
    const write = queue.then(() => persistStore(nextStore)).then(() => {
      store = nextStore;
    });
    const handled = write.then(() => undefined, (error) => {
      storeError = `Could not clamp and save widget positions: ${errorMessage(error)}`;
      logError('could not clamp and save widget positions', error);
    });
    queue = handled.then(() => undefined);
    return handled.finally(() => {
      pendingWrites = Math.max(0, pendingWrites - 1);
    }).then(() => {
      if (!storeError && active && !stopping) {
        reconcileWindows();
        notifyPreferences();
      }
    });
  }

  function beforeQuit(event) {
    if (stopped) return;
    if (pendingWrites > 0 || [...windows.values()].some((record) => record.geometryTimer)) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      if (appQuitAfterStop) return;
      appQuitAfterStop = true;
      void stop().then(() => {
        try { app.quit(); } catch (error) { logError('could not finish app shutdown', error); }
      });
      return;
    }
    void finishStop();
  }

  function removeListeners() {
    for (const [channel, handler] of ipcHandlers) {
      try { ipcMain.removeHandler(channel); } catch (_) {}
      void handler;
    }
    ipcHandlers.clear();
    for (const [channel, listener] of ipcListeners) {
      try { ipcMain.removeListener(channel, listener); } catch (_) {}
    }
    ipcListeners.clear();
    for (const [event, listener] of screenListeners) {
      try { screen.removeListener(event, listener); } catch (_) {}
    }
    screenListeners.length = 0;
    try { app.removeListener('before-quit', beforeQuit); } catch (_) {}
  }

  function finishStop() {
    if (stopped) return Promise.resolve();
    stopped = true;
    stopping = true;
    active = false;
    removeListeners();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const [id, record] of Array.from(windows.entries())) safeCloseWindow(id, record);
    return Promise.resolve();
  }

  function stopService() {
    if (stopped) return Promise.resolve();
    if (stopPromise) return stopPromise;
    for (const record of windows.values()) {
      if (!record.geometryTimer) continue;
      clearTimeout(record.geometryTimer);
      timers.delete(record.geometryTimer);
      record.geometryTimer = null;
      void persistNativeGeometry(record);
    }
    stopping = true;
    if (pendingWrites === 0) {
      stopPromise = finishStop();
      return stopPromise;
    }
    stopPromise = queue.then(() => finishStop());
    return stopPromise;
  }

  return { start: startService, updateFeatures: setFeatures, stop: stopService };
}

module.exports = { start, updateFeatures, stop };
