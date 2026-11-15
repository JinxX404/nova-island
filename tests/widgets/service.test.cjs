'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const WidgetModel = require('../../widgets/model');
const WidgetService = require('../../widgets');

function createEnvironment(t, options = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-widget-service-'));
  const windows = [];
  const handlers = new Map();
  const ipcListeners = new Map();
  const prefsContents = new Set();
  const openedExternal = [];
  const openedPaths = [];
  const notifications = [];
  const menus = [];
  const openedSettings = [];
  const screen = new EventEmitter();
  screen.workArea = options.workArea || { x: -1280, y: 0, width: 1280, height: 900 };
  screen.getDisplayMatching = () => ({ workArea: screen.workArea });
  screen.getPrimaryDisplay = () => ({ workArea: screen.workArea });

  class FakeWebContents extends EventEmitter {
    constructor() {
      super();
      this.mainFrame = {};
      this.url = 'about:blank';
      this.sent = [];
      this.destroyed = false;
    }
    getURL() { return this.url; }
    isDestroyed() { return this.destroyed; }
    setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
    send(channel, value) { this.sent.push({ channel, value }); }
  }

  class FakeWindow extends EventEmitter {
    constructor(windowOptions) {
      super();
      this.options = windowOptions;
      this.bounds = {
        x: windowOptions.x,
        y: windowOptions.y,
        width: windowOptions.width,
        height: windowOptions.height,
      };
      this.webContents = new FakeWebContents();
      this.destroyed = false;
      let contents = this.webContents;
      Object.defineProperty(this, 'webContents', {
        get() { if (this.destroyed) throw new Error('Object has been destroyed'); return contents; },
        set(value) { contents = value; },
      });
      this.shownInactive = false;
      this.windowsSettings = {};
      windows.push(this);
      FakeWindow.byContents.set(this.webContents, this);
    }
    setMenu(menu) { this.menu = menu; }
    setMinimumSize(width, height) { this.minimumSize = { width, height }; }
    setResizable(value) { this.windowsSettings.resizable = value; }
    setMovable(value) { this.windowsSettings.movable = value; }
    setBounds(bounds) { this.bounds = { ...bounds }; }
    getBounds() { return { ...this.bounds }; }
    isDestroyed() { return this.destroyed; }
    showInactive() { this.shownInactive = true; }
    async loadFile(file, settings = {}) {
      const url = pathToFileURL(file);
      const params = new URLSearchParams(settings.query || {});
      url.search = params.toString();
      this.webContents.url = url.href;
      setImmediate(() => this.emit('ready-to-show'));
      return undefined;
    }
    close() {
      if (this.destroyed) return;
      let prevented = false;
      const event = { preventDefault() { prevented = true; } };
      this.emit('close', event);
      if (!prevented) this.destroy();
    }
    destroy() {
      if (this.destroyed) return;
      const contents = this.webContents;
      this.destroyed = true;
      contents.destroyed = true;
      this.emit('closed');
      FakeWindow.byContents.delete(contents);
    }
    userSetBounds(bounds) {
      this.bounds = { ...bounds };
      this.emit('move');
      this.emit('resize');
    }
  }
  FakeWindow.byContents = new Map();
  FakeWindow.fromWebContents = (contents) => FakeWindow.byContents.get(contents) || null;

  const app = new EventEmitter();
  app.getPath = (name) => {
    assert.equal(name, 'userData');
    return userData;
  };
  app.quitCalls = 0;
  app.quit = () => { app.quitCalls += 1; };

  const ipcMain = new EventEmitter();
  ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
  ipcMain.removeHandler = (channel) => handlers.delete(channel);
  ipcMain.on = (channel, listener) => {
    if (!ipcListeners.has(channel)) ipcListeners.set(channel, new Set());
    ipcListeners.get(channel).add(listener);
  };
  ipcMain.removeListener = (channel, listener) => {
    ipcListeners.get(channel)?.delete(listener);
  };

  const dialog = {
    nextOpenResult: { canceled: true, filePaths: [] },
    async showOpenDialog() { return this.nextOpenResult; },
  };
  const nativeImage = {
    createFromBuffer(buffer) {
      const good = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      return { isEmpty: () => !good };
    },
  };
  const shell = {
    async openExternal(target) { openedExternal.push(target); },
    async openPath(target) { openedPaths.push(target); return ''; },
  };
  const Menu = { choice: null, buildFromTemplate(template) { menus.push(template); return { popup({ callback }) {
    template.find((item) => item.label === Menu.choice && item.enabled !== false)?.click();
    callback();
  } }; } };
  const electron = { app, BrowserWindow: FakeWindow, ipcMain, screen, dialog, shell, nativeImage, Menu };

  const prefsWindow = makeSender(pathToFileURL(path.join(__dirname, '..', '..', 'prefs', 'index.html')).href);
  prefsContents.add(prefsWindow.sender);
  const optionsForService = {
    electron,
    getFeatures: () => ({ theme: 'dark', noAnimations: false }),
    notifyPrefs: (store) => notifications.push(store),
    openSettings: (id) => openedSettings.push(id),
    isPrefs: (sender) => prefsContents.has(sender),
  };
  WidgetService.start({ ...optionsForService, ...options.serviceOptions });

  function makeSender(url) {
    const contents = new FakeWebContents();
    contents.url = url;
    const win = new FakeWindow({ x: 0, y: 0, width: 640, height: 480 });
    win.webContents = contents;
    FakeWindow.byContents.set(contents, win);
    return { sender: contents, window: win };
  }

  function eventFor(sender, senderFrame = sender.mainFrame) {
    return { sender, senderFrame, preventDefault() { this.prevented = true; } };
  }

  async function invoke(channel, sender, ...args) {
    const handler = handlers.get(channel);
    assert.ok(handler, `missing IPC handler ${channel}`);
    return handler(eventFor(sender), ...args);
  }

  function send(channel, sender, ...args) {
    const listeners = ipcListeners.get(channel);
    assert.ok(listeners && listeners.size, `missing IPC listener ${channel}`);
    for (const listener of listeners) listener(eventFor(sender), ...args);
  }

  const env = {
    userData, windows, handlers, ipcListeners, prefsContents, prefsWindow, ipcMain, electron,
    openedExternal, openedPaths, notifications, openedSettings, screen, dialog,
    app, invoke, send, makeSender, eventFor, menus,
    widgetWindows() { return windows.filter((win) => win.options.title?.startsWith('Nova widget:') && !win.destroyed); },
    storePath: path.join(userData, 'widgets.json'),
    async stop() { await WidgetService.stop(); },
    restart() { return WidgetService.start(optionsForService); },
  };
  t.after(async () => {
    await env.stop();
    fs.rmSync(userData, { recursive: true, force: true });
  });
  return env;
}

function makeSender(url) {
  const contents = new EventEmitter();
  contents.mainFrame = {};
  contents.url = url;
  contents.getURL = () => contents.url;
  contents.isDestroyed = () => false;
  return contents;
}

function desktopSender(env) {
  const win = env.widgetWindows()[0];
  assert.ok(win, 'expected a native widget window');
  return win.webContents;
}

async function addText(env, overrides = {}) {
  const draft = WidgetModel.createWidget('text', 'note', 'renderer-provisional-id');
  draft.content.text = 'Original';
  Object.assign(draft, overrides);
  const result = await env.invoke('widgets-save', env.prefsWindow.sender, draft);
  assert.equal(result.ok, true, result.error);
  assert.notEqual(result.widget.id, 'renderer-provisional-id');
  return result.widget;
}

async function waitForWidget(env, id, predicate) {
  const start = Date.now();
  while (Date.now() - start < 5000) {
    const widget = (await env.invoke('widgets-get', env.prefsWindow.sender)).widgets.find((item) => item.id === id);
    if (predicate(widget)) return widget;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Timed out waiting for persisted widget state');
}

test('native windows use isolated web contents and prefs IPC requires both trusted URL and identity', async (t) => {
  const env = createEnvironment(t);
  const widget = await addText(env);
  await new Promise((resolve) => setImmediate(resolve));
  const window = env.widgetWindows()[0];
  assert.equal(window.options.title, 'Nova widget: text');
  assert.equal(window.options.skipTaskbar, true);
  assert.equal(window.options.resizable, false);
  assert.equal(window.options.movable, false);
  assert.equal(Object.hasOwn(window.options, 'alwaysOnTop'), false);
  assert.deepEqual(window.options.webPreferences, {
    preload: path.join(__dirname, '..', '..', 'widgets', 'preload.js'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
  });
  assert.ok(window.shownInactive);
  WidgetService.updateFeatures({ theme: 'light', noAnimations: true });
  const pushedState = window.webContents.sent.filter((message) => message.channel === 'widget-state').at(-1);
  assert.deepEqual(pushedState.value.features, { theme: 'light', noAnimations: true });

  const actualStore = await env.invoke('widgets-get', env.prefsWindow.sender);
  assert.equal(actualStore.widgets[0].id, widget.id);
  const impostor = env.makeSender(env.prefsWindow.sender.getURL());
  assert.equal((await env.invoke('widgets-save', impostor, WidgetModel.createWidget())).ok, false);
  await assert.rejects(env.invoke('widgets-pick-app', impostor), /Unauthorized/);
  const trickUrl = env.makeSender(`${env.prefsWindow.sender.getURL()}?route=widgets`);
  env.prefsContents.add(trickUrl);
  await assert.rejects(env.invoke('widgets-get', trickUrl), /Unauthorized/);
  await assert.rejects(env.handlers.get('widgets-get')(env.eventFor(env.prefsWindow.sender, {})), /Unauthorized/);

  const foreignDesktop = env.makeSender(window.webContents.getURL());
  assert.equal((await env.invoke('widget-action', foreignDesktop, 'delete')).ok, false);
});

test('future-version stores are read-only and retain their bytes', async (t) => {
  const env = createEnvironment(t);
  const future = '{"version":9,"widgets":[{"future":"keep me"}]}\n';
  fs.writeFileSync(env.storePath, future, 'utf8');
  await env.stop();
  WidgetService.start({
    electron: env.electron,
    getFeatures: () => ({}),
    isPrefs: (sender) => sender === env.prefsWindow.sender,
  });
  const result = await env.invoke('widgets-save', env.prefsWindow.sender, WidgetModel.createWidget());
  assert.equal(result.ok, false);
  assert.match(result.error, /newer than supported version/);
  await assert.rejects(env.invoke('widgets-get', env.prefsWindow.sender), /newer than supported version/);
  assert.equal(fs.readFileSync(env.storePath, 'utf8'), future);
  assert.equal(env.widgetWindows().length, 0);
});

test('startup clamps persisted positions before exposing widgets or creating native windows', async (t) => {
  const env = createEnvironment(t);
  await env.stop();
  const savedWidget = WidgetModel.createWidget('text', 'note', 'startup-widget');
  savedWidget.position = { x: 5000, y: -900 };
  fs.writeFileSync(env.storePath, JSON.stringify({ version: 1, widgets: [savedWidget] }), 'utf8');
  env.restart();

  const loaded = await env.invoke('widgets-get', env.prefsWindow.sender);
  assert.deepEqual(loaded.widgets[0].position, { x: -320, y: 0 });
  const persisted = JSON.parse(fs.readFileSync(env.storePath, 'utf8'));
  assert.deepEqual(persisted.widgets[0].position, { x: -320, y: 0 });
  assert.equal(env.widgetWindows().length, 1);
});

test('writes commit before changing windows; lock preserves geometry while content and auto-height remain usable', async (t) => {
  const env = createEnvironment(t, { workArea: { x: -800, y: 0, width: 800, height: 900 } });
  const widget = await addText(env, {
    position: { x: -740, y: 130 },
    layout: { width: 320, height: 180, autoHeight: true },
  });
  const currentWindow = env.widgetWindows()[0];

  const originalRename = fs.promises.rename;
  fs.promises.rename = async () => { throw new Error('simulated atomic rename failure'); };
  try {
    const failed = await env.invoke('widgets-save', env.prefsWindow.sender, WidgetModel.createWidget('goal'));
    assert.equal(failed.ok, false);
    assert.match(failed.error, /simulated atomic rename failure/);
  } finally {
    fs.promises.rename = originalRename;
  }
  const afterFailure = await env.invoke('widgets-get', env.prefsWindow.sender);
  assert.deepEqual(afterFailure.widgets.map((item) => item.id), [widget.id]);
  assert.equal(env.widgetWindows().length, 1);
  assert.equal(currentWindow.isDestroyed(), false);

  const locked = await env.invoke('widgets-action', env.prefsWindow.sender, widget.id, 'lock');
  assert.equal(locked.ok, true);
  const sender = desktopSender(env);
  assert.deepEqual(await env.invoke('widget-editing', sender, true), {
    ok: false,
    error: 'Unlock this widget before editing its geometry',
  });
  assert.equal((await env.invoke('widget-geometry', sender, { x: -300 })).ok, false);

  const edited = { ...locked.widget, content: { ...locked.widget.content, text: 'Updated while locked' }, position: { x: 200, y: 210 }, layout: { width: 550, height: 290, autoHeight: false } };
  const saved = await env.invoke('widgets-save', env.prefsWindow.sender, edited);
  assert.equal(saved.ok, true);
  assert.equal(saved.widget.content.text, 'Updated while locked');
  assert.equal(saved.widget.position.x, widget.position.x);
  assert.equal(saved.widget.position.y, widget.position.y);
  assert.equal(saved.widget.layout.width, widget.layout.width);
  assert.equal(saved.widget.layout.height, widget.layout.height);
  assert.equal(saved.widget.locked, true);

  env.send('widget-measure', sender, 310);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const measured = (await env.invoke('widgets-get', env.prefsWindow.sender)).widgets[0];
  assert.equal(measured.position.x, widget.position.x);
  assert.equal(measured.position.y, widget.position.y);
  assert.equal(measured.layout.height, 310);

  const unlocked = await env.invoke('widgets-action', env.prefsWindow.sender, widget.id, 'unlock');
  assert.equal(unlocked.ok, true);
  assert.equal((await env.invoke('widget-editing', sender, true)).editing, true);
  const geometry = await env.invoke('widget-geometry', sender, { x: -100, width: 420, height: 240 });
  assert.equal(geometry.ok, true);
  assert.deepEqual(geometry.widget.position, { x: -420, y: widget.position.y });
  assert.equal(geometry.widget.layout.width, 420);
  assert.equal(geometry.widget.layout.height, 240);
  assert.equal(geometry.widget.layout.autoHeight, false);
});

test('a queued lock rejects geometry accepted before the lock committed', async (t) => {
  const env = createEnvironment(t);
  const widget = await addText(env);
  const sender = desktopSender(env);
  await env.invoke('widget-editing', sender, true);
  const originalRename = fs.promises.rename;
  let enteredResolve, release;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  fs.promises.rename = (...args) => {
    enteredResolve();
    return new Promise((resolve, reject) => { release = () => originalRename(...args).then(resolve, reject); });
  };
  try {
    const lock = env.invoke('widgets-action', env.prefsWindow.sender, widget.id, 'lock');
    await entered;
    const geometry = env.invoke('widget-geometry', sender, { width: 500 });
    release();
    assert.equal((await lock).ok, true);
    assert.equal((await geometry).ok, false);
    assert.equal((await env.invoke('widgets-get', env.prefsWindow.sender)).widgets[0].layout.width, widget.layout.width);
  } finally { fs.promises.rename = originalRename; }
});

test('shutdown flushes the last native resize before its debounce expires', async (t) => {
  const env = createEnvironment(t);
  const widget = await addText(env);
  const sender = desktopSender(env);
  await env.invoke('widget-editing', sender, true);
  const win = env.widgetWindows()[0];
  win.userSetBounds({ ...win.getBounds(), width: 400, height: 220 });
  await env.stop();
  const saved = JSON.parse(fs.readFileSync(env.storePath, 'utf8')).widgets[0];
  assert.equal(saved.id, widget.id);
  assert.equal(saved.layout.width, 400);
  assert.equal(saved.layout.height, 220);
  assert.equal(saved.layout.autoHeight, false);
});

test('shutdown waits for an in-flight atomic save before allowing app quit', async (t) => {
  const env = createEnvironment(t);
  const originalRename = fs.promises.rename;
  let enteredResolve;
  let releaseRename;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  fs.promises.rename = (...args) => {
    enteredResolve();
    return new Promise((resolve, reject) => {
      releaseRename = () => originalRename(...args).then(resolve, reject);
    });
  };
  try {
    const save = env.invoke('widgets-save', env.prefsWindow.sender, WidgetModel.createWidget('goal'));
    await entered;
    const quitEvent = { prevented: false, preventDefault() { this.prevented = true; } };
    env.app.emit('before-quit', quitEvent);
    assert.equal(quitEvent.prevented, true);
    assert.equal(env.app.quitCalls, 0);
    releaseRename();
    const result = await save;
    assert.equal(result.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(env.app.quitCalls, 1);
    assert.equal(JSON.parse(fs.readFileSync(env.storePath, 'utf8')).widgets.length, 1);
  } finally {
    fs.promises.rename = originalRename;
  }
});

test('duplicate, hide, show, delete, and edit actions are scoped to the owning widget', async (t) => {
  const env = createEnvironment(t);
  const widget = await addText(env);
  const sender = desktopSender(env);
  const duplicate = await env.invoke('widgets-action', env.prefsWindow.sender, widget.id, 'duplicate');
  assert.equal(duplicate.ok, true);
  assert.notEqual(duplicate.widget.id, widget.id);
  assert.equal(duplicate.widget.locked, false);
  assert.equal(duplicate.widget.hidden, false);

  const desktopDuplicate = await env.invoke('widget-action', sender, 'duplicate');
  assert.equal(desktopDuplicate.ok, true);
  assert.notEqual(desktopDuplicate.widget.id, widget.id);
  const edit = await env.invoke('widget-action', sender, 'edit');
  assert.deepEqual(edit, { ok: true });
  assert.deepEqual(env.openedSettings, [widget.id]);

  const desktopHidden = await env.invoke('widget-action', sender, 'hide');
  assert.equal(desktopHidden.ok, true);
  await env.invoke('widgets-action', env.prefsWindow.sender, widget.id, 'show');
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(env.widgetWindows().length, 3);

  const hidden = await env.invoke('widgets-action', env.prefsWindow.sender, widget.id, 'hide');
  assert.equal(hidden.widget.hidden, true);
  assert.equal(env.widgetWindows().length, 2);
  const shown = await env.invoke('widgets-action', env.prefsWindow.sender, widget.id, 'show');
  assert.equal(shown.widget.hidden, false);
  assert.equal(env.widgetWindows().length, 3);
  const removed = await env.invoke('widgets-action', env.prefsWindow.sender, duplicate.widget.id, 'delete');
  assert.equal(removed.ok, true);
  const after = await env.invoke('widgets-get', env.prefsWindow.sender);
  assert.equal(after.widgets.some((item) => item.id === duplicate.widget.id), false);
});

test('app and website links require safe saved targets; app picker and image picker validate selected files', async (t) => {
  const env = createEnvironment(t);
  const links = WidgetModel.createWidget('links');
  links.content.items = [
    { id: 'launch', label: 'Demo', icon: 'D', type: 'app', target: 'C:\\Apps\\Demo.exe' },
    { id: 'docs', label: 'Docs', icon: 'W', type: 'website', target: 'https://example.com/help' },
  ];
  const denied = await env.invoke('widgets-save', env.prefsWindow.sender, links);
  assert.equal(denied.ok, false);
  assert.match(denied.error, /app picker/);

  env.dialog.nextOpenResult = { canceled: false, filePaths: ['C:\\Apps\\Demo.exe'] };
  const picked = await env.invoke('widgets-pick-app', env.prefsWindow.sender);
  assert.deepEqual(picked, { target: 'C:\\Apps\\Demo.exe', label: 'Demo' });
  const saved = await env.invoke('widgets-save', env.prefsWindow.sender, links);
  assert.equal(saved.ok, true, saved.error);
  const sender = desktopSender(env);
  assert.equal((await env.invoke('widget-open-link', sender, 0)).ok, true);
  assert.equal((await env.invoke('widget-open-link', sender, 1)).ok, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(env.openedPaths, ['C:\\Apps\\Demo.exe']);
  assert.deepEqual(env.openedExternal, ['https://example.com/help']);

  const unsafe = WidgetModel.createWidget('links');
  unsafe.content.items = [{ id: 'bad', label: 'Run', icon: '', type: 'website', target: 'javascript:alert(1)' }];
  assert.equal((await env.invoke('widgets-save', env.prefsWindow.sender, unsafe)).ok, false);

  const imagePath = path.join(env.userData, 'picture.png');
  fs.writeFileSync(imagePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
  env.dialog.nextOpenResult = { canceled: false, filePaths: [imagePath] };
  const image = await env.invoke('widgets-pick-image', env.prefsWindow.sender);
  assert.equal(image.name, 'picture.png');
  assert.match(image.dataUrl, /^data:image\/png;base64,/);

  const wrongExtension = path.join(env.userData, 'picture.jpg');
  fs.writeFileSync(wrongExtension, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
  env.dialog.nextOpenResult = { canceled: false, filePaths: [wrongExtension] };
  await assert.rejects(env.invoke('widgets-pick-image', env.prefsWindow.sender), /signature does not match/);
});

test('display changes clamp and persist negative-origin positions; links only open from their owning window', async (t) => {
  const env = createEnvironment(t, { workArea: { x: -1200, y: -400, width: 1200, height: 800 } });
  const widget = await addText(env, { position: { x: -1000, y: 250 } });
  env.screen.workArea = { x: -600, y: -300, width: 600, height: 500 };
  env.screen.emit('display-metrics-changed');
  const saved = await waitForWidget(env, widget.id, (current) => current.position.x >= -600);
  assert.ok(saved.position.x >= -600);
  assert.ok(saved.position.y >= -300);
  assert.equal(saved.position.x, -600);

  const sender = desktopSender(env);
  const request = await env.invoke('widget-get', sender);
  assert.equal(request.widget.id, widget.id);
  assert.deepEqual(request.workArea, env.screen.workArea);
  const blocked = env.makeSender(sender.getURL());
  assert.equal((await env.invoke('widget-open-link', blocked, 0)).ok, false);
  assert.deepEqual(env.openedExternal, []);
});

test('desktop preload exposes only the widget bridge methods and routes IPC arguments explicitly', () => {
  const preloadPath = require.resolve('../../widgets/preload');
  const originalLoad = Module._load;
  const calls = [];
  const subscriptions = new Map();
  let bridge;
  const fakeElectron = {
    contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'widget'); bridge = value; } },
    ipcRenderer: {
      invoke(channel, ...args) { calls.push(['invoke', channel, ...args]); return Promise.resolve(true); },
      send(channel, ...args) { calls.push(['send', channel, ...args]); },
      on(channel, listener) { subscriptions.set(channel, listener); },
      removeListener(channel, listener) { if (subscriptions.get(channel) === listener) subscriptions.delete(channel); },
    },
  };
  delete require.cache[preloadPath];
  Module._load = function loadWithFakeElectron(request, parent, isMain) {
    if (request === 'electron') return fakeElectron;
    return originalLoad.call(this, request, parent, isMain);
  };
  try { require(preloadPath); }
  finally {
    Module._load = originalLoad;
    delete require.cache[preloadPath];
  }

  assert.deepEqual(Object.keys(bridge), ['get', 'action', 'editing', 'editor', 'content', 'adjustGoal', 'pickImage', 'pickApp', 'geometry', 'measure', 'openLink', 'onState']);
  bridge.get();
  bridge.action('hide');
  bridge.editing(true);
  bridge.editor(true);
  bridge.content({ text: 'Inline' });
  bridge.adjustGoal(1);
  bridge.pickImage();
  bridge.pickApp();
  bridge.geometry({ x: -100 });
  bridge.measure(200);
  bridge.openLink(2);
  let received = null;
  const unsubscribe = bridge.onState((state) => { received = state; });
  const state = { widget: { id: 'owned' } };
  subscriptions.get('widget-state')({}, state);
  unsubscribe();
  assert.equal(received, state);
  assert.equal(subscriptions.has('widget-state'), false);
  assert.deepEqual(calls, [
    ['invoke', 'widget-get'],
    ['invoke', 'widget-action', 'hide'],
    ['invoke', 'widget-editing', true],
    ['invoke', 'widget-editor', true],
    ['invoke', 'widget-content', { text: 'Inline' }],
    ['invoke', 'widget-goal-step', 1],
    ['invoke', 'widget-pick-image'],
    ['invoke', 'widget-pick-app'],
    ['invoke', 'widget-geometry', { x: -100 }],
    ['send', 'widget-measure', 200],
    ['invoke', 'widget-open-link', 2],
  ]);
});

test('direct geometry needs no edit toggle and inline bounds never persist on cancel or shutdown', async (t) => {
  const env = createEnvironment(t);
  const widget = await addText(env, { position: { x: -900, y: 100 } });
  const sender = desktopSender(env), win = env.widgetWindows()[0];
  const moved = await env.invoke('widget-geometry', sender, { x: -860, y: 120 });
  assert.equal(moved.ok, true);
  assert.deepEqual(moved.widget.position, { x: -860, y: 120 });
  const before = JSON.parse(fs.readFileSync(env.storePath, 'utf8'));
  assert.equal((await env.invoke('widget-editor', sender, true)).ok, true);
  assert.equal(win.getBounds().height, 500);
  assert.equal((await env.invoke('widget-geometry', sender, { x: -500 })).ok, false);
  env.send('widget-measure', sender, 490);
  assert.deepEqual(JSON.parse(fs.readFileSync(env.storePath, 'utf8')), before);
  assert.equal((await env.invoke('widget-content', sender, { ...widget.content, text: 'Saved inline' })).ok, true);
  assert.equal(win.getBounds().height, 500, 'a save does not shrink the form mid-operation');
  assert.equal((await env.invoke('widget-editor', sender, false)).ok, true);
  assert.equal(win.getBounds().height, widget.layout.height);
  const saved = (await env.invoke('widgets-get', env.prefsWindow.sender)).widgets[0];
  assert.deepEqual(saved.appearance, widget.appearance);
  assert.deepEqual(saved.layout, widget.layout);
  assert.deepEqual(saved.position, moved.widget.position);
  await env.invoke('widget-editor', sender, true);
  await env.stop();
  assert.deepEqual(JSON.parse(fs.readFileSync(env.storePath, 'utf8')).widgets[0], saved, 'shutdown ignores temporary editor dimensions');
});

test('inline content stays scoped to its sender and validates links and goal arithmetic atomically', async (t) => {
  const env = createEnvironment(t);
  const goal = await env.invoke('widgets-save', env.prefsWindow.sender, WidgetModel.createWidget('goal'));
  const sender = desktopSender(env);
  const other = await addText(env);
  const foreign = env.makeSender(sender.getURL());
  for (const [channel, value] of [['widget-content', { title: 'Attack' }], ['widget-goal-step', 1], ['widget-editor', true]]) {
    assert.equal((await env.invoke(channel, foreign, value)).ok, false);
    assert.equal((await env.handlers.get(channel)(env.eventFor(sender, {}), value)).ok, false);
  }
  await assert.rejects(env.invoke('widget-pick-image', foreign), /Unauthorized/);
  const results = await Promise.all(Array.from({ length: 8 }, () => env.invoke('widget-goal-step', sender, 1)));
  assert.ok(results.every((result) => result.ok));
  assert.equal((await env.invoke('widget-get', sender)).widget.content.current, 8);
  assert.equal((await env.invoke('widget-goal-step', sender, 2)).ok, false);
  const bad = await env.invoke('widget-content', sender, { ...goal.widget.content, target: 0 });
  assert.equal(bad.ok, false);
  const good = await env.invoke('widget-content', sender, { ...goal.widget.content, current: 0, id: other.id, kind: 'text' });
  assert.equal(good.ok, true);
  assert.equal(good.widget.id, goal.widget.id);
  assert.equal(good.widget.kind, 'goal');
  await env.invoke('widget-goal-step', sender, -1);
  assert.equal((await env.invoke('widget-get', sender)).widget.content.current, 0);
  assert.equal((await env.invoke('widgets-get', env.prefsWindow.sender)).widgets.find((w) => w.id === other.id).content.text, 'Original');
  await env.invoke('widgets-action', env.prefsWindow.sender, goal.widget.id, 'lock');
  assert.equal((await env.invoke('widget-geometry', sender, { x: -400 })).ok, false);
  assert.equal((await env.invoke('widget-goal-step', sender, 1)).ok, true, 'position lock allows progress updates');
});

test('inline desktop picker approval and native menu remain owned and bounded', async (t) => {
  const env = createEnvironment(t);
  const links = WidgetModel.createWidget('links');
  await env.invoke('widgets-save', env.prefsWindow.sender, links);
  const sender = desktopSender(env);
  const content = { ...links.content, items: [{ id: 'app', label: 'App', icon: '', type: 'app', target: 'C:\\Apps\\Demo.exe' }] };
  assert.equal((await env.invoke('widget-content', sender, content)).ok, false);
  env.dialog.nextOpenResult = { canceled: false, filePaths: ['C:\\Apps\\Demo.exe'] };
  const picked = await env.invoke('widget-pick-app', sender);
  assert.equal(picked.target, content.items[0].target);
  assert.equal((await env.invoke('widget-content', sender, content)).ok, true);
  await assert.rejects(env.invoke('widget-pick-image', sender), /Unauthorized/);
  env.electron.Menu.choice = 'Edit content';
  assert.deepEqual(await env.invoke('widget-action', sender, 'menu'), { ok: true, action: 'inline-edit' });
  assert.equal(env.menus[0].filter((item) => item.label === 'Edit content').length, 1);
  env.electron.Menu.choice = 'Lock position';
  assert.equal((await env.invoke('widget-action', sender, 'menu')).widget.locked, true);
  env.electron.Menu.choice = 'Move with keyboard';
  assert.deepEqual(await env.invoke('widget-action', sender, 'menu'), { ok: true });
});

test('the latest auto-height request wins even when it equals bounds before an in-flight write', async (t) => {
  const env = createEnvironment(t);
  const widget = await addText(env);
  const sender = desktopSender(env);
  const originalRename = fs.promises.rename;
  let enteredResolve, release;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  let intercepted = false;
  fs.promises.rename = (...args) => {
    if (intercepted) return originalRename(...args);
    intercepted = true; enteredResolve();
    return new Promise((resolve, reject) => { release = () => originalRename(...args).then(resolve, reject); });
  };
  try {
    env.send('widget-measure', sender, 320);
    await entered;
    env.send('widget-measure', sender, widget.layout.height);
    release();
    await env.stop();
    assert.equal(JSON.parse(fs.readFileSync(env.storePath, 'utf8')).widgets[0].layout.height, widget.layout.height);
  } finally { fs.promises.rename = originalRename; }
});

test('fractional native display rounding never changes saved geometry without a direct gesture', async (t) => {
  const env = createEnvironment(t);
  const widget = await addText(env);
  const win = env.widgetWindows()[0];
  const before = win.getBounds();
  win.userSetBounds({ ...before, x: before.x + 1, width: before.width + 1, height: before.height + 1 });
  const latest = { ...widget, content: { ...widget.content, text: 'New content' } };
  assert.equal((await env.invoke('widgets-save', env.prefsWindow.sender, latest)).ok, true);
  await env.stop();
  const saved = JSON.parse(fs.readFileSync(env.storePath, 'utf8')).widgets[0];
  assert.deepEqual(saved.position, widget.position);
  assert.deepEqual(saved.layout, widget.layout);
});
