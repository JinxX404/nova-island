'use strict';
const { app, BrowserWindow, dialog, shell, screen, ipcMain, Menu } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = process.env.NOVA_WIDGET_TEST_ROOT;
assert.ok(root && path.resolve(root).startsWith(path.join(os.tmpdir(), 'nova-widgets-')), 'Explicit temporary test root required');
for (const name of ['', 'Desktop', 'SessionData', 'dynamic-nova']) fs.mkdirSync(path.join(root, name), { recursive: true });
app.setPath('appData', root);
app.setPath('desktop', path.join(root, 'Desktop'));
app.setPath('sessionData', path.join(root, 'SessionData'));
app.commandLine.appendSwitch('force-device-scale-factor', process.env.NOVA_WIDGET_TEST_SCALE || '1');
const stage = process.env.NOVA_WIDGET_TEST_STAGE;
const profile = path.join(root, 'dynamic-nova');
if (stage === 'create') {
  fs.writeFileSync(path.join(profile, 'renamed'), 'isolated test');
  fs.writeFileSync(path.join(profile, 'features.json'), JSON.stringify({
    autoUpdate: false, news: false, noBlur: true, noAnimations: true, downloads: false,
    folderDownloads: false, clipboardHistory: false, smartClipboard: false,
    screenshotToast: false, shotAutoShelf: false, privacyDots: false,
    reminders: false, prayerAlerts: false, netToasts: false, meetings: false,
    morningBrief: false, wellbeing: false, welcomeBack: false, addrIsland: false,
  }));
}
let chosenFile = null;
const opened = [];
dialog.showOpenDialog = async () => ({ canceled: !chosenFile, filePaths: chosenFile ? [chosenFile] : [] });
shell.openExternal = async (target) => { opened.push(target); };
shell.openPath = async (target) => { opened.push(target); return ''; };
const errors = [];
const widgetMenus = [];
const buildMenu = Menu.buildFromTemplate.bind(Menu);
Menu.buildFromTemplate = (template) => {
  const menu = buildMenu(template);
  if (template.some((item) => item.label === 'Edit content')) {
    const record = { menu, shown: false, closed: false };
    menu.on('menu-will-show', () => { record.shown = true; });
    menu.on('menu-will-close', () => { record.closed = true; });
    widgetMenus.push(record);
  }
  return menu;
};
function fatal(error) {
  const message = error?.stack || String(error);
  fs.writeFileSync(path.join(root, 'main-failure.txt'), message);
  console.error(message);
  app.exit(1);
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
let saveDelay = 0;
const register = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => register(channel, channel === 'widgets-save'
  ? async (...args) => { if (saveDelay) await new Promise((resolve) => setTimeout(resolve, saveDelay)); return handler(...args); }
  : handler);
app.on('web-contents-created', (_event, wc) => wc.on('console-message', (event) => {
  if ((event.level === 'error' || event.level === 3) && /\/(widgets|prefs)\//.test(wc.getURL())) errors.push(event.message);
}));
require('../../nova');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = (win, fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true);
async function until(fn, message, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await fn();
    if (result) return result;
    await delay(40);
  }
  throw new Error('Timed out: ' + message);
}
async function ready(win) {
  await until(() => !win.webContents.isLoading() && win.webContents.getURL().startsWith('file:'), 'window load');
  await evaluate(win, () => document.fonts.ready.then(() => true));
}
async function capture(win, file) {
  await evaluate(win, () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))));
  await fs.promises.writeFile(file, (await win.webContents.capturePage()).toPNG());
}
async function field(win, label, value) {
  await evaluate(win, (label, value) => {
    const el = document.querySelector(`#widgets [aria-label="${label}"]`);
    if (!el) throw new Error('Missing field ' + label);
    el.value = value; el.dispatchEvent(new Event('input', { bubbles: true }));
  }, label, value);
}
async function button(win, text) {
  await evaluate(win, (text) => {
    const b = [...document.querySelectorAll('#widgets button')].find((el) => el.textContent === text && el.offsetWidth);
    if (!b) throw new Error('Missing visible button ' + text);
    b.click();
  }, text);
}
async function add(win, kind) {
  await button(win, 'Add widget');
  await evaluate(win, (kind) => document.querySelectorAll('.wg-addchip')[kind].click(), kind);
  await until(() => evaluate(win, () => !document.getElementById('wg-editor').hidden), 'editor');
}
async function saved(win, count) {
  await button(win, 'Save');
  await until(() => evaluate(win, async (count) => (await window.prefs.widgets()).widgets.length === count && document.getElementById('wg-editor').hidden, count), 'save ' + count);
}
async function store(win) { return evaluate(win, () => window.prefs.widgets()); }
function widgetWindow(id) {
  return BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/widgets/index.html') && new URL(w.webContents.getURL()).searchParams.get('id') === id);
}
async function native(win, method, ...args) {
  return evaluate(win, (method, args) => window.widget[method](...args), method, args);
}
async function dragControl(win, id, dx, dy) {
  await evaluate(win, () => {
    window.__pointerTrace = [];
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'lostpointercapture']) document.addEventListener(type, (e) => {
      window.__pointerTrace.push([type, e.target.id, e.button, e.buttons, e.screenX, e.screenY, e.clientX, e.clientY]);
    }, { capture: true });
  });
  const point = await evaluate(win, (id) => {
    const r = document.getElementById(id).getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, id);
  const bounds = win.getBounds();
  const global = { globalX: bounds.x + point.x, globalY: bounds.y + point.y };
  const endGlobal = { globalX: global.globalX + dx, globalY: global.globalY + dy };
  win.focus();
  win.webContents.sendInputEvent({ type: 'mouseMove', ...point, ...global });
  win.webContents.sendInputEvent({ type: 'mouseDown', ...point, ...global, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x + dx, y: point.y + dy, ...endGlobal, modifiers: ['leftButtonDown'] });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x + dx, y: point.y + dy, ...endGlobal, button: 'left', clickCount: 1 });
}
async function clickControl(win, selector) {
  const point = await evaluate(win, (selector) => {
    const node = document.querySelector(selector);
    if (!node) throw new Error('Missing control ' + selector);
    node.scrollIntoView({ block: 'nearest' });
    const r = node.getBoundingClientRect();
    if (!r.width || !r.height || r.top < 0 || r.bottom > innerHeight + 1) throw new Error('Control is not visible ' + selector);
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, selector);
  win.focus();
  win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
}
async function inlineOpen(win) {
  win.focus();
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F2' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F2' });
  await until(() => evaluate(win, () => !!document.querySelector('.widget-inline-editor')), 'inline content editor');
}
async function inlineField(win, label, value) {
  await evaluate(win, (label, value) => {
    const node = document.querySelector(`.widget-inline-editor [aria-label="${label}"]`);
    if (!node) throw new Error('Missing inline field ' + label);
    node.value = value; node.dispatchEvent(new Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  }, label, value);
}
async function inlineSave(win) {
  await clickControl(win, '.wie-save');
  await until(() => evaluate(win, () => !document.querySelector('.widget-inline-editor')), 'inline save');
}
async function run() {
  await app.whenReady();
  assert.equal(app.getPath('userData'), profile);
  require('../../prefs-window').open('widgets');
  let prefs = await until(() => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Nova Island Settings'), 'Settings');
  await ready(prefs);
  await until(() => evaluate(prefs, () => !!window.WidgetSettings && document.querySelector('#widgets.page.on')), 'Widgets page');
  if (stage !== 'create') {
    const actual = await store(prefs);
    const expected = JSON.parse(fs.readFileSync(path.join(root, 'expected.json'), 'utf8'));
    assert.deepEqual(actual.widgets.map((w) => [w.id, w.kind, w.content, w.appearance, w.hidden, w.locked]),
      expected.widgets.map((w) => [w.id, w.kind, w.content, w.appearance, w.hidden, w.locked]));
    if (stage === 'restart') assert.deepEqual(actual, expected, 'complete instance state persists across restart');
    for (const w of actual.widgets.filter((w) => !w.hidden)) {
      const win = await until(() => widgetWindow(w.id), 'restored widget');
      await ready(win);
      const b = win.getBounds(), area = screen.getDisplayMatching(b).workArea;
      assert.ok(b.x >= area.x && b.y >= area.y && b.x + b.width <= area.x + area.width && b.y + b.height <= area.y + area.height);
    }
    const note = actual.widgets.find((w) => w.kind === 'text' && !w.hidden);
    windowForScale = widgetWindow(note.id);
    if (stage === 'restart') {
      await evaluate(prefs, (id) => window.WidgetSettings.open(id), note.id);
      await field(prefs, 'Text', 'Closing the window discards this draft');
      prefs.close();
      await until(() => prefs.isDestroyed(), 'Settings closed');
      require('../../prefs-window').open('widgets');
      prefs = await until(() => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Nova Island Settings'), 'reopened Settings');
      await ready(prefs);
      assert.equal(await evaluate(prefs, () => window.WidgetSettings.isEditing()), false);
      assert.equal((await store(prefs)).widgets[0].content.text, note.content.text);
    }
    if (stage === 'scaled') {
      prefs.setSize(640, 480);
      prefs.webContents.setZoomFactor(1.5);
      await evaluate(prefs, (id) => window.WidgetSettings.open(id), note.id);
      await delay(120);
      assert.equal(await evaluate(prefs, () => document.querySelector('#widgets textarea').value.includes('العربية')), true);
      assert.equal(await evaluate(prefs, () => getComputedStyle(document.querySelector('#widgets textarea')).fontSize), '13px');
      assert.equal(await evaluate(windowForScale, () => getComputedStyle(document.querySelector('.widget-card')).fontSize), '20px');
      assert.equal(await evaluate(prefs, () => document.querySelector('.widget-title').style.textTransform || getComputedStyle(document.querySelector('.widget-title')).textTransform), 'none');
      assert.equal(await evaluate(prefs, () => document.getElementById('content').scrollWidth <= document.getElementById('content').clientWidth + 1), true, 'content has no horizontal overflow');
      await evaluate(prefs, () => document.querySelector('[aria-label="Font weight"]').scrollIntoView());
      assert.equal(await evaluate(prefs, () => {
        const group = document.querySelector('[aria-label="Font weight"]');
        return group.scrollWidth <= group.clientWidth + 1;
      }), true, 'appearance controls wrap');
      await evaluate(prefs, () => document.getElementById('wg-editor').scrollIntoView());
      await capture(prefs, path.join(root, 'scale-' + process.env.NOVA_WIDGET_TEST_SCALE + '.png'));
      await evaluate(prefs, () => window.WidgetSettings.cancel());
      // Pointer deltas remain screen DIPs at each forced display scale.
      await native(windowForScale, 'action', 'unlock');
      const before = windowForScale.getBounds();
      await dragControl(windowForScale, 'resize', 20, -10);
      await until(() => windowForScale.getBounds().width === before.width + 20, 'scaled pointer resize');
      const beforeMove = windowForScale.getBounds();
      const moveArea = screen.getDisplayMatching(beforeMove).workArea;
      const dy = beforeMove.y > moveArea.y + 8 ? -8 : 8;
      const expectedY = Math.min(moveArea.y + moveArea.height - beforeMove.height, Math.max(moveArea.y, beforeMove.y + dy));
      await dragControl(windowForScale, 'scroll', 18, dy);
      await until(() => windowForScale.getBounds().x === beforeMove.x + 18 && windowForScale.getBounds().y === expectedY, 'scaled direct card drag');
      await inlineOpen(windowForScale);
      assert.equal(await evaluate(windowForScale, () => document.activeElement.getAttribute('aria-label')), 'Title');
      await inlineField(windowForScale, 'Text', 'Temporary العربية English');
      await capture(windowForScale, path.join(root, 'inline-scale-' + process.env.NOVA_WIDGET_TEST_SCALE + '.png'));
      windowForScale.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      await until(() => evaluate(windowForScale, () => !document.querySelector('.widget-inline-editor')), 'scaled Escape cancel');
      if (process.env.NOVA_WIDGET_TEST_SCALE === '1.25') {
        assert.equal((await native(windowForScale, 'geometry', { width: 321, height: 199 })).ok, true);
        await windowForScale.webContents.reload(); await ready(windowForScale);
        await inlineOpen(windowForScale);
        windowForScale.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        await until(() => evaluate(windowForScale, () => !document.querySelector('.widget-inline-editor')), 'fractional reload cancel');
        const retained = (await native(windowForScale, 'get')).widget;
        assert.deepEqual(retained.layout, { width: 321, height: 199, autoHeight: false }, 'odd DIP dimensions survive reload and temporary editing');
      }
      await evaluate(prefs, (w) => window.prefs.saveWidget(w), note);
    }
  } else {
    assert.equal((await store(prefs)).widgets.length, 0);
    await add(prefs, 0);
    await button(prefs, 'Statement');
    await until(() => evaluate(prefs, () => getComputedStyle(document.querySelector('.wg-holder .widget-card')).fontSize === '32px'), 'statement preview');
    assert.deepEqual(await evaluate(prefs, () => { const s = getComputedStyle(document.querySelector('.wg-holder .widget-card')); return [s.fontSize, s.textAlign]; }), ['32px', 'center']);
    await button(prefs, 'Label');
    await until(() => evaluate(prefs, () => getComputedStyle(document.querySelector('.wg-holder .widget-card')).padding === '8px'), 'label preview');
    assert.equal(await evaluate(prefs, () => getComputedStyle(document.querySelector('.wg-holder .widget-card')).padding), '8px');
    await button(prefs, 'Note');
    await button(prefs, 'Wide 480');
    await until(() => evaluate(prefs, () => document.querySelector('.wg-holder').style.width === '480px'), 'wide preset');
    await button(prefs, 'Medium 320');
    const text = '**Bold** and *italic*\n- العربية English\n1. Mixed list\n<img src=x onerror=alert(1)>';
    await field(prefs, 'Title', 'Plan موعد');
    await field(prefs, 'Text', text);
    await until(() => evaluate(prefs, () => document.querySelector('.wg-holder').textContent.includes('<img src=x')), 'live text preview');
    assert.equal(await evaluate(prefs, () => document.querySelector('.wg-holder').textContent.includes('<img src=x')), true);
    assert.equal(await evaluate(prefs, () => document.querySelectorAll('.wg-holder img').length), 0);
    assert.ok(await evaluate(prefs, () => !!document.querySelector('.wg-holder strong') && !!document.querySelector('.wg-holder em') && !!document.querySelector('.wg-holder li')));
    await button(prefs, 'Cancel');
    assert.equal((await store(prefs)).widgets.length, 0, 'cancel new draft');
    assert.equal(await evaluate(prefs, () => document.activeElement.id), 'wg-add');
    await add(prefs, 0);
    await field(prefs, 'Title', 'Plan موعد');
    await field(prefs, 'Text', text);
    saveDelay = 250;
    await button(prefs, 'Save');
    assert.equal(await evaluate(prefs, () => document.querySelector('#widgets textarea').matches(':disabled')), true, 'save freezes the submitted draft');
    await until(() => evaluate(prefs, () => document.getElementById('wg-editor').hidden), 'initial save');
    saveDelay = 0;
    let note = (await store(prefs)).widgets[0];
    const win = await until(() => widgetWindow(note.id), 'text window');
    await ready(win);
    await delay(160);
    const initial = win.getBounds();
    await evaluate(prefs, (id) => window.WidgetSettings.open(id), note.id);
    await field(prefs, 'Text', 'cancel this');
    await field(prefs, 'Title', 'cancel title');
    prefs.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    prefs.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await until(() => evaluate(prefs, () => document.getElementById('wg-editor').hidden), 'Escape cancel');
    assert.equal(await evaluate(prefs, () => document.activeElement.textContent), 'Edit');
    assert.equal((await store(prefs)).widgets[0].content.text, text);
    await clickControl(win, '#menu');
    await until(() => widgetMenus.at(-1)?.shown, 'real native options menu opens');
    widgetMenus.at(-1).menu.closePopup(win);
    await until(() => widgetMenus.at(-1).closed, 'native menu closes without action');
    await evaluate(prefs, (id) => window.WidgetSettings.open(id), note.id);
    await field(prefs, 'Text', (text + '\n').repeat(100));
    await saved(prefs, 1);
    await until(() => win.getBounds().height > initial.height, 'auto growth');
    assert.equal(win.getBounds().x, initial.x); assert.equal(win.getBounds().y, initial.y);
    assert.ok(win.getBounds().height <= 640, 'auto height cap');
    assert.equal(await evaluate(win, () => document.getElementById('scroll').scrollHeight > document.getElementById('scroll').clientHeight), true);
    assert.equal((await native(win, 'geometry', { width: 220 })).ok, true);
    await until(() => win.getBounds().width === 220, 'width reflow');
    const fontBefore = await evaluate(win, () => getComputedStyle(document.querySelector('.widget-card')).fontSize);
    await evaluate(win, () => document.getElementById('resize').focus());
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
    await until(() => win.getBounds().width === 230, 'keyboard resize');
    await evaluate(win, () => {
      for (let i = 0; i < 5; i++) document.getElementById('resize').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    await until(() => win.getBounds().width === 280, 'repeated keyboard steps accumulate');
    const moveStart = win.getBounds();
    await dragControl(win, 'scroll', 20, -10);
    await until(() => win.getBounds().x === moveStart.x + 20 && win.getBounds().y === moveStart.y - 10, 'pointer move preserves DIP distance');
    const resizeStart = win.getBounds();
    await dragControl(win, 'resize', 20, -10);
    await until(() => win.getBounds().width === resizeStart.width + 20, 'pointer resize');
    assert.equal(await evaluate(win, () => getComputedStyle(document.querySelector('.widget-card')).fontSize), fontBefore);
    assert.equal(await evaluate(win, () => document.querySelector('[role="toolbar"]')), null, 'old toolbar removed');
    const keyboardStart = win.getBounds();
    await evaluate(win, () => document.getElementById('scroll').focus());
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right', modifiers: ['alt'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right', modifiers: ['alt'] });
    await until(() => win.getBounds().x === keyboardStart.x + 10, 'direct keyboard move');
    const originalInline = (await store(prefs)).widgets[0];
    await inlineOpen(win);
    const inlineBounds = win.getBounds();
    assert.ok(inlineBounds.height >= 400);
    assert.equal(await evaluate(win, () => document.activeElement.getAttribute('aria-label')), 'Title');
    await inlineField(win, 'Text', 'Discard this inline draft');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await until(() => evaluate(win, () => !document.querySelector('.widget-inline-editor')), 'inline Escape cancels');
    assert.equal(await evaluate(win, () => document.activeElement.id), 'menu');
    assert.deepEqual((await store(prefs)).widgets[0].content, originalInline.content);
    assert.deepEqual(win.getBounds(), { ...originalInline.position, width: originalInline.layout.width, height: originalInline.layout.height });
    await inlineOpen(win);
    await inlineField(win, 'Text', text);
    await inlineSave(win);
    await until(() => evaluate(win, () => !!document.querySelector('strong') && !!document.querySelector('li')), 'inline formatted text saved');
    assert.equal((await store(prefs)).widgets[0].content.text, text);
    await native(win, 'action', 'lock');
    const locked = win.getBounds();
    assert.equal((await native(win, 'geometry', { x: locked.x + 100, width: 480 })).ok, false);
    assert.deepEqual(win.getBounds(), locked);
    await dragControl(win, 'scroll', 20, -10);
    assert.deepEqual(win.getBounds(), locked, 'locked cards do not drag');
    await native(win, 'action', 'duplicate');
    await until(async () => (await store(prefs)).widgets.length === 2, 'duplicate');
    let all = await store(prefs);
    const duplicate = all.widgets.find((w) => w.id !== note.id);
    duplicate.content.text = 'Independent duplicate';
    assert.equal((await evaluate(prefs, (w) => window.prefs.saveWidget(w), duplicate)).ok, true);
    // Moving away from a bottom-edge clamp must restore the intrinsic auto height.
    const dupWin = await until(() => widgetWindow(duplicate.id), 'duplicate window'); await ready(dupWin);
    const area = screen.getDisplayMatching(dupWin.getBounds()).workArea;
    duplicate.position = { x: area.x + 30, y: area.y + area.height - 180 };
    duplicate.layout = { width: 320, height: 180, autoHeight: true };
    duplicate.content.text = 'A line of Arabic العربية and English\n'.repeat(60);
    await evaluate(prefs, (w) => window.prefs.saveWidget(w), duplicate);
    await until(() => dupWin.getBounds().height <= 180, 'bottom-edge auto height cap');
    await native(dupWin, 'geometry', { y: area.y + 30 });
    await until(() => dupWin.getBounds().height > 180, 'auto height recovers after move');
    await native(dupWin, 'geometry', { height: 100 });
    let autoAgain = (await store(prefs)).widgets.find((w) => w.id === duplicate.id);
    autoAgain.layout.autoHeight = true;
    await evaluate(prefs, (w) => window.prefs.saveWidget(w), autoAgain);
    await until(() => dupWin.getBounds().height > 100, 'fixed height back to automatic');
    await evaluate(prefs, (id) => window.prefs.widgetAction(id, 'hide'), duplicate.id);
    assert.equal((await store(prefs)).widgets[0].content.text.includes('العربية'), true);
    await until(() => !widgetWindow(duplicate.id), 'hidden window');
    // Shared appearance survives independently of the duplicate.
    note = (await store(prefs)).widgets[0];
    Object.assign(note.appearance, { fontSize: 20, fontWeight: 600, align: 'end', lineHeight: 1.8,
      textColor: '#ffffff', backgroundColor: '#203040', accentColor: '#aaccff', opacity: 0.7, padding: 24, direction: 'rtl' });
    assert.equal((await evaluate(prefs, (w) => window.prefs.saveWidget(w), note)).ok, true);
    await until(() => evaluate(win, () => getComputedStyle(document.querySelector('.widget-paragraph')).direction === 'rtl'), 'explicit RTL direction');
    assert.equal(await evaluate(win, () => getComputedStyle(document.querySelector('.widget-card')).textAlign), 'end');
    assert.deepEqual(await evaluate(win, () => {
      const s = getComputedStyle(document.getElementById('card'));
      const bg = getComputedStyle(document.getElementById('card'), '::before');
      return [s.fontSize, s.fontWeight, s.lineHeight, s.padding, s.color, bg.backgroundColor, bg.opacity];
    }), ['20px', '600', '36px', '24px', 'rgb(255, 255, 255)', 'rgb(32, 48, 64)', '0.7']);
    // Countdown
    await add(prefs, 1); await field(prefs, 'Event name', 'Launch إطلاق');
    await field(prefs, 'Target date and time', ''); await button(prefs, 'Save');
    assert.equal(await evaluate(prefs, () => document.activeElement.getAttribute('aria-invalid')), 'true');
    await field(prefs, 'Target date and time', '2030-01-01T12:00');
    await button(prefs, 'Days only'); await saved(prefs, 3);
    // Quick links, including native-approved app selection.
    await add(prefs, 2); await button(prefs, '+ Website');
    await field(prefs, 'Link 1 name', 'Docs');
    await field(prefs, 'Link 1 website address', 'https://user:pass@example.com');
    await button(prefs, 'Save');
    assert.equal(await evaluate(prefs, () => document.activeElement.getAttribute('aria-invalid')), 'true');
    await field(prefs, 'Link 1 website address', 'https://example.com/docs');
    await field(prefs, 'Link 1 icon (text or emoji)', '↗');
    await evaluate(prefs, () => {
      const group = document.querySelector('[aria-label="Link 1 type"]');
      const selected = group.querySelector('[aria-checked="true"]');
      selected.focus();
      selected.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      if (document.activeElement.textContent !== 'App') throw new Error('Link type arrow navigation');
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    await field(prefs, 'Link 1 website address', 'https://example.com/docs');
    await button(prefs, 'Grid');
    chosenFile = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'notepad.exe');
    await button(prefs, '+ App');
    await until(() => evaluate(prefs, () => document.querySelectorAll('.wg-linkit').length === 2), 'app chosen');
    await saved(prefs, 4);
    const links = (await store(prefs)).widgets.find((w) => w.kind === 'links');
    const linkWin = await until(() => widgetWindow(links.id), 'links window'); await ready(linkWin);
    assert.equal((await native(linkWin, 'openLink', 0)).ok, true);
    assert.equal((await native(linkWin, 'openLink', 1)).ok, true);
    assert.equal(opened.length, 2);
    // Image uses a real PNG, copied into persisted data.
    chosenFile = path.join(root, 'fixture.png');
    fs.writeFileSync(chosenFile, (await win.webContents.capturePage()).toPNG());
    await add(prefs, 3); await button(prefs, 'Choose file…');
    await until(() => evaluate(prefs, () => !!document.querySelector('.wg-thumb')), 'image chosen');
    await field(prefs, 'Caption', 'صورة Image'); await button(prefs, 'Fit inside'); await saved(prefs, 5);
    fs.unlinkSync(chosenFile); // Restoring the image must not depend on the original file.
    // Goal
    await add(prefs, 4); await field(prefs, 'Goal name', 'Reading قراءة');
    await field(prefs, 'Current amount', '42'); await field(prefs, 'Target amount', '0'); await button(prefs, 'Save');
    assert.equal(await evaluate(prefs, () => document.activeElement.getAttribute('aria-invalid')), 'true');
    await field(prefs, 'Target amount', '100');
    await button(prefs, 'Ring'); await saved(prefs, 6);
    for (const w of (await store(prefs)).widgets.filter((w) => !w.hidden)) {
      const visible = await until(() => widgetWindow(w.id), 'created widget');
      await ready(visible);
      await until(() => evaluate(visible, () => [...document.images].every((img) => img.complete)), 'widget images');
    }
    const countdownWin = widgetWindow((await store(prefs)).widgets.find((w) => w.kind === 'countdown').id);
    const imageWin = widgetWindow((await store(prefs)).widgets.find((w) => w.kind === 'image').id);
    const goalWin = widgetWindow((await store(prefs)).widgets.find((w) => w.kind === 'goal').id);
    assert.match(await evaluate(countdownWin, () => document.querySelector('.widget-countdown-value').textContent), /days remaining/);
    assert.equal(await evaluate(imageWin, () => getComputedStyle(document.querySelector('.widget-image-content')).objectFit), 'contain');
    assert.equal(await evaluate(goalWin, () => document.querySelector('[role="progressbar"]').getAttribute('aria-valuenow')), '42');
    await clickControl(goalWin, '#goal-plus');
    await until(() => evaluate(goalWin, () => document.querySelector('[role="progressbar"]').getAttribute('aria-valuenow') === '43'), 'goal plus updates');
    await clickControl(goalWin, '#goal-minus');
    await until(() => evaluate(goalWin, () => document.querySelector('[role="progressbar"]').getAttribute('aria-valuenow') === '42'), 'goal minus updates');
    const goalPosition = goalWin.getBounds();
    await clickControl(goalWin, '#goal-edit');
    await until(() => evaluate(goalWin, () => !!document.querySelector('.widget-inline-editor')), 'inline goal edit');
    await inlineField(goalWin, 'Goal name', 'Reading العربية');
    await inlineField(goalWin, 'Current amount', '25');
    await inlineField(goalWin, 'Target amount', '100');
    await inlineField(goalWin, 'Unit', 'pages');
    await capture(goalWin, path.join(root, 'inline-goal.png'));
    await inlineSave(goalWin);
    await until(() => evaluate(goalWin, () => document.querySelector('[role="progressbar"]').getAttribute('aria-valuenow') === '25'), 'inline goal persisted');
    assert.deepEqual({ x: goalWin.getBounds().x, y: goalWin.getBounds().y }, { x: goalPosition.x, y: goalPosition.y }, 'inline edit restores position');
    // Every content kind has a working desktop editor.
    await inlineOpen(countdownWin);
    await inlineField(countdownWin, 'Event name', 'Inline launch');
    await inlineSave(countdownWin);
    assert.equal((await native(countdownWin, 'get')).widget.content.title, 'Inline launch');
    await inlineOpen(imageWin);
    await inlineField(imageWin, 'Caption', 'Inline صورة');
    await inlineField(imageWin, 'Image fit', 'cover');
    await inlineSave(imageWin);
    assert.equal((await native(imageWin, 'get')).widget.content.caption, 'Inline صورة');
    await inlineOpen(linkWin);
    await inlineField(linkWin, 'Link 1 name', 'Inline Docs');
    await inlineSave(linkWin);
    assert.equal((await native(linkWin, 'get')).widget.content.items[0].label, 'Inline Docs');
    const linksBounds = linkWin.getBounds();
    await clickControl(linkWin, '.widget-link-button');
    assert.deepEqual(linkWin.getBounds(), linksBounds, 'link activation does not drag the card');
    await capture(goalWin, path.join(root, 'desktop-goal.png'));
    assert.equal(await evaluate(linkWin, () => !!document.querySelector('.widget-links--grid')), true);
    const featureService = require('../../features');
    for (const theme of ['original', 'bakka', 'outline', 'midnight', 'forest', 'snow', 'cat', 'galaxy', 'aurora', 'ocean', 'nody', 'lava', 'retro']) {
      featureService.set({ theme });
      await until(() => evaluate(countdownWin, (theme) => document.body.dataset.theme === theme, theme), 'theme propagation');
      assert.equal(await evaluate(countdownWin, () => {
        const layer = getComputedStyle(document.getElementById('card'), '::before');
        return layer.backgroundImage !== 'none' || layer.backgroundColor !== 'rgba(0, 0, 0, 0)';
      }), true);
    }
    featureService.set({ theme: 'snow' });
    await until(() => evaluate(goalWin, () => document.body.dataset.theme === 'snow'), 'light editor theme');
    await inlineOpen(goalWin);
    assert.equal(await evaluate(goalWin, () => {
      const bg = getComputedStyle(document.getElementById('inline')).backgroundImage;
      const token = getComputedStyle(document.body).getPropertyValue('--th-bg').trim();
      return bg !== 'none' || !!token;
    }), true, 'inline form uses light theme background');
    await capture(goalWin, path.join(root, 'inline-goal-light.png'));
    goalWin.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await until(() => evaluate(goalWin, () => !document.querySelector('.widget-inline-editor')), 'light editor closes');
    featureService.set({ theme: 'original', noAnimations: false });
    for (const visible of [win, countdownWin, linkWin, imageWin, goalWin]) {
      await until(() => evaluate(visible, () => document.body.dataset.theme === 'original'), 'all widget themes restored');
    }
    await until(() => evaluate(countdownWin, () => !document.body.classList.contains('no-anim')), 'animation preference');
    countdownWin.webContents.debugger.attach('1.3');
    await countdownWin.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    assert.equal(await evaluate(countdownWin, () => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
    countdownWin.webContents.debugger.detach();
    featureService.set({ noAnimations: true });
    await evaluate(prefs, (id) => window.WidgetSettings.open(id), note.id);
    await field(prefs, 'Text', 'Navigation should discard this');
    await evaluate(prefs, () => document.querySelector('[data-page="general"]').click());
    assert.equal(await evaluate(prefs, () => window.WidgetSettings.isEditing()), false);
    await evaluate(prefs, () => document.querySelector('[data-page="widgets"]').click());
    assert.equal((await store(prefs)).widgets[0].content.text, note.content.text);
    let previous = '', stable = 0;
    await until(async () => {
      const current = JSON.stringify(await store(prefs));
      stable = current === previous ? stable + 1 : 0;
      previous = current;
      await delay(100);
      return stable >= 4;
    }, 'measured geometry settled');
    const expected = await store(prefs);
    assert.deepEqual(new Set(expected.widgets.map((w) => w.kind)), new Set(['text', 'countdown', 'links', 'image', 'goal']));
    fs.writeFileSync(path.join(root, 'expected.json'), JSON.stringify(expected, null, 2));
    await capture(win, path.join(root, 'desktop-text.png'));
    await capture(prefs, path.join(root, 'settings.png'));
    const island = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/index.html') && !w.webContents.getURL().includes('/prefs/'));
    assert.ok(island);
    assert.equal(await evaluate(island, () => !!document.getElementById('island')), true);
    assert.ok(await evaluate(prefs, async () => (await window.prefs.general()).version));
  }
  await delay(100);
  assert.deepEqual(errors, [], 'widget/Settings renderer errors');
  fs.writeFileSync(path.join(root, stage + '-' + process.env.NOVA_WIDGET_TEST_SCALE + '.json'),
    JSON.stringify({ stage, scale: process.env.NOVA_WIDGET_TEST_SCALE, profile, errors, widgets: (await store(prefs)).widgets.length }, null, 2));
}
let windowForScale;
app.whenReady().then(() => run()).then(() => { console.log('ELECTRON_STAGE_OK', stage); app.quit(); })
  .catch(async (error) => {
    console.error(error.stack);
    fs.writeFileSync(path.join(root, 'failure.txt'), error.stack);
    fs.writeFileSync(path.join(root, 'renderer-errors.json'), JSON.stringify(errors));
    for (const [i, win] of BrowserWindow.getAllWindows().entries()) {
      try {
        if (!/\/(widgets|prefs)\//.test(win.webContents.getURL())) continue;
        const shot = await Promise.race([win.webContents.capturePage(), new Promise((resolve) => setTimeout(() => resolve(null), 2000))]);
        if (shot) fs.writeFileSync(path.join(root, `failure-${i}.png`), shot.toPNG());
        fs.writeFileSync(path.join(root, `failure-${i}.json`), JSON.stringify({ bounds: win.getBounds(), dom: await evaluate(win, () => ({
          url: location.href, html: document.querySelector('.wg-holder')?.outerHTML,
          text: document.querySelector('#widgets')?.textContent, focus: document.activeElement?.outerHTML, pointers: window.__pointerTrace,
        })) }, null, 2));
      } catch {}
    }
    app.exit(1);
  });
