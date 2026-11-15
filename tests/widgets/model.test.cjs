'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '../../widgets/model.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const model = require(sourcePath);

function widgetWith(overrides = {}) {
  return {
    id: 'widget-test',
    kind: 'text',
    content: {},
    appearance: {},
    layout: {},
    position: {},
    ...overrides,
  };
}

function linkWidget(item, overrides = {}) {
  return model.normalizeWidget({
    id: 'links-test',
    kind: 'links',
    content: { items: [item] },
    ...overrides,
  });
}

test('exports a browser global and a CommonJS API with frozen catalog constants', () => {
  assert.doesNotMatch(source, /\brequire\s*\(|from\s+['"]electron['"]/i);
  assert.deepEqual(model.KINDS, ['text', 'countdown', 'links', 'image', 'goal']);
  assert.deepEqual(model.PRESETS, ['note', 'statement', 'label']);
  assert.deepEqual(model.SIZE_PRESETS, { compact: 220, medium: 320, wide: 480 });
  assert.equal(model.MAX_WIDGETS, 32);
  assert.equal(Object.isFrozen(model.KINDS), true);
  assert.equal(Object.isFrozen(model.SIZE_PRESETS), true);

  const browserWindow = {};
  vm.runInNewContext(source, { window: browserWindow });
  assert.equal(typeof browserWindow.WidgetModel.createWidget, 'function');
  assert.equal(browserWindow.WidgetModel.MAX_WIDGETS, 32);
});

test('factory creates independent defaults for every kind and unique safe IDs', () => {
  const kinds = model.KINDS.map((kind) => model.createWidget(kind));
  assert.deepEqual(kinds.map((widget) => widget.kind), model.KINDS);
  assert.equal(new Set(kinds.map((widget) => widget.id)).size, kinds.length);
  assert.ok(kinds.every((widget) => /^[A-Za-z0-9_-]{1,80}$/.test(widget.id)));

  const [note, countdown, links, image, goal] = kinds;
  assert.deepEqual(note.content, { title: 'Note', text: '', preset: 'note' });
  assert.deepEqual(note.appearance, {
    fontSize: 18, fontWeight: 400, align: 'start', lineHeight: 1.5,
    textColor: null, backgroundColor: null, accentColor: null, opacity: 0.92,
    padding: 20, direction: 'auto',
  });
  assert.deepEqual(note.layout, { width: 320, height: 180, autoHeight: true });
  assert.deepEqual(note.position, { x: 24, y: 100 });
  assert.equal(note.hidden, false);
  assert.equal(note.locked, false);
  assert.equal(Number.isFinite(Date.parse(countdown.content.target)), true);
  assert.ok(Date.parse(countdown.content.target) > Date.now());
  assert.deepEqual(links.content, { title: 'Quick links', arrangement: 'list', items: [] });
  assert.deepEqual(image.content, { dataUrl: '', name: '', caption: '', fit: 'cover', imageHeight: 180 });
  assert.deepEqual(goal.content, { title: 'My goal', current: 0, target: 100, unit: '', progress: 'bar' });

  const first = model.createWidget();
  const second = model.createWidget();
  first.content.text = 'mutated';
  first.position.x = -500;
  assert.equal(second.content.text, '');
  assert.equal(second.position.x, 24);
});

test('text presets supply their defaults and explicit IDs are validated', () => {
  const statement = model.createWidget('text', 'statement', 'statement_1');
  assert.equal(statement.id, 'statement_1');
  assert.deepEqual(statement.content, { title: 'Note', text: '', preset: 'statement' });
  assert.equal(statement.appearance.fontSize, 32);
  assert.equal(statement.appearance.fontWeight, 600);
  assert.equal(statement.appearance.align, 'center');
  assert.equal(statement.appearance.padding, 28);

  const label = model.createWidget('text', 'label');
  assert.deepEqual(label.content, { title: '', text: '', preset: 'label' });
  assert.equal(label.appearance.fontSize, 16);
  assert.equal(label.appearance.padding, 8);
  assert.equal(label.layout.width, 220);

  assert.throws(() => model.createWidget('video'), /kind is invalid/);
  assert.throws(() => model.createWidget('text', 'card'), /preset is invalid/);
  assert.throws(() => model.createWidget('text', 'note', ''), /identifier/);
  assert.throws(() => model.createWidget('text', 'note', 'not safe'), /identifier/);
  assert.throws(() => model.createWidget('text', 'note', 'x'.repeat(81)), /80/);
});

test('normalization fills harmless omissions, clamps finite numbers, rounds DIP values, and strips unknown keys', () => {
  const input = JSON.parse('{"id":"safe-1","kind":"text","content":{"preset":"note","text":"<img src=x onerror=1>","extra":"drop"},"appearance":{"fontSize":99,"fontWeight":750,"align":"end","lineHeight":0.5,"opacity":9,"padding":80,"direction":"rtl","__proto__":{"polluted":true},"extra":1},"layout":{"width":999,"height":2,"autoHeight":false,"extra":1},"position":{"x":-12.7,"y":100.6},"extra":true,"__proto__":{"polluted":true}}');
  const normalized = model.normalizeWidget(input);

  assert.equal(normalized.appearance.fontSize, 72);
  assert.equal(normalized.appearance.fontWeight, 700);
  assert.equal(normalized.appearance.align, 'end');
  assert.equal(normalized.appearance.lineHeight, 1);
  assert.equal(normalized.appearance.opacity, 1);
  assert.equal(normalized.appearance.padding, 48);
  assert.equal(normalized.appearance.direction, 'rtl');
  assert.deepEqual(normalized.layout, { width: 720, height: 64, autoHeight: false });
  assert.deepEqual(normalized.position, { x: -13, y: 101 });
  assert.equal(normalized.content.text, '<img src=x onerror=1>');
  assert.equal(Object.hasOwn(normalized, 'extra'), false);
  assert.equal(Object.hasOwn(normalized.appearance, 'extra'), false);
  assert.equal(Object.hasOwn(normalized.content, 'extra'), false);
  assert.equal({}.polluted, undefined);
  assert.equal(input.content.extra, 'drop');

  const label = model.normalizeWidget({ kind: 'text', content: { preset: 'label', title: 'ignored title' } });
  assert.equal(label.content.title, 'ignored title');
  assert.equal(label.layout.width, 220);
  assert.equal(label.appearance.padding, 8);
});

test('omitted fields default while explicitly invalid or nonfinite values throw', () => {
  const defaults = model.normalizeWidget({});
  assert.equal(defaults.kind, 'text');
  assert.equal(defaults.content.title, 'Note');
  assert.equal(defaults.appearance.fontSize, 18);
  assert.equal(defaults.layout.width, 320);
  assert.deepEqual(defaults.position, { x: 24, y: 100 });

  for (const value of [NaN, Infinity, -Infinity, '18', null]) {
    assert.throws(() => model.normalizeWidget(widgetWith({ appearance: { fontSize: value } })), /finite number/);
  }
  assert.throws(() => model.normalizeWidget(widgetWith({ layout: { width: NaN } })), /finite number/);
  assert.throws(() => model.normalizeWidget(widgetWith({ position: { x: Infinity } })), /finite number/);
  assert.throws(() => model.normalizeWidget(widgetWith({ appearance: { opacity: undefined } })), /finite number/);
  assert.throws(() => model.normalizeWidget(widgetWith({ appearance: { align: 'left' } })), /align is invalid/);
  assert.throws(() => model.normalizeWidget(widgetWith({ appearance: { accentColor: 'red' } })), /#RRGGBB/);
  assert.throws(() => model.normalizeWidget(widgetWith({ hidden: 1 })), /boolean/);
  assert.throws(() => model.normalizeWidget(widgetWith({ kind: 'unknown' })), /kind is invalid/);
  assert.throws(() => model.normalizeWidget(widgetWith({ content: null })), /content must be an object/);
  assert.throws(() => model.normalizeWidget(widgetWith({ content: { preset: 'other' } })), /preset is invalid/);
  assert.throws(() => model.normalizeWidget(widgetWith({ content: { text: 'x'.repeat(20001) } })), /20000/);
});

test('countdown targets require real ISO dates and formats are restricted', () => {
  const countdown = model.normalizeWidget({ kind: 'countdown', content: { target: '2032-02-29T13:45:00.000Z', format: 'date' } });
  assert.equal(countdown.content.target, '2032-02-29T13:45:00.000Z');
  assert.equal(countdown.content.format, 'date');
  assert.equal(model.normalizeWidget({ kind: 'countdown', content: { target: '2032-02-29T13:45' } }).content.target, '2032-02-29T13:45');
  assert.equal(model.createWidget('countdown').content.title, 'My event');

  for (const target of ['not a date', '2031-02-29', '2032-02-30', '2032-01-01T25:00:00Z', '']) {
    assert.throws(() => model.normalizeWidget({ kind: 'countdown', content: { target } }), /valid ISO date/);
  }
  assert.throws(() => model.normalizeWidget({ kind: 'countdown', content: { format: 'relative' } }), /format is invalid/);
});

test('links accept only safe website URLs or absolute Windows executable shortcuts', () => {
  const bookIcon = String.fromCodePoint(0x1f4da);
  const website = linkWidget({ id: 'link-1', label: 'Docs', target: 'https://example.com/docs?q=1', icon: bookIcon });
  assert.deepEqual(website.content.items[0], {
    id: 'link-1', label: 'Docs', icon: bookIcon, type: 'website', target: 'https://example.com/docs?q=1',
  });
  const app = linkWidget({ id: 'link-2', label: 'App', type: 'app', target: 'C:\\Program Files\\Nova\\Nova.exe' });
  assert.equal(app.content.items[0].type, 'app');
  assert.equal(app.content.items[0].target, 'C:\\Program Files\\Nova\\Nova.exe');
  const unc = linkWidget({ label: 'Shortcut', type: 'app', target: '\\\\server\\share\\Nova.lnk' });
  assert.match(unc.content.items[0].id, /^[A-Za-z0-9_-]+$/);

  for (const target of [
    'javascript:alert(1)', 'data:text/html,hi', 'file:///C:/app.exe', 'https://example.com bad',
    'https://user:secret@example.com', 'https://', 'https:\\\\example.com',
  ]) {
    assert.throws(() => linkWidget({ label: 'Bad', target }), /target/);
  }
  for (const target of ['relative.exe', '/opt/app.exe', 'C:app.exe', 'C:\\temp\\run.cmd', 'C:\\bad|name.exe', '\\\\server\\share']) {
    assert.throws(() => linkWidget({ label: 'Bad', type: 'app', target }), /target|path|segments|end in/);
  }
  assert.throws(() => linkWidget({ label: 'No target' }), /target is required/);
  assert.throws(() => linkWidget({ label: 'Bad icon', icon: '<b>' , target: 'https://example.com' }), /icon/);
  assert.throws(() => linkWidget({ label: 'Long icon', icon: '123456789', target: 'https://example.com' }), /icon/);
  assert.throws(() => linkWidget({ label: 'x'.repeat(101), target: 'https://example.com' }), /100/);
  assert.throws(() => model.normalizeWidget({ kind: 'links', content: { arrangement: 'tiles' } }), /arrangement is invalid/);
  assert.throws(() => model.normalizeWidget({ kind: 'links', content: { items: Array(25).fill({ target: 'https://example.com' }) } }), /24/);
  assert.throws(() => linkWidget({ id: 'same', target: 'https://example.com' }, {
    content: { items: [{ id: 'same', target: 'https://example.com' }, { id: 'same', target: 'https://example.net' }] },
  }), /unique/);
});

test('image data URLs must be bounded, canonical base64 with a matching raster signature', () => {
  const examples = [
    ['image/png', 'iVBORw0KGgo='],
    ['image/jpeg', '/9j/'],
    ['image/gif', 'R0lGODlh'],
    ['image/webp', 'UklGRgAAAABXRUJQ'],
  ];
  for (const [mime, payload] of examples) {
    const image = model.normalizeWidget({ kind: 'image', content: { dataUrl: `data:${mime};base64,${payload}` } });
    assert.equal(image.content.dataUrl, `data:${mime};base64,${payload}`);
  }
  assert.equal(model.normalizeWidget({ kind: 'image', content: { imageHeight: 999, fit: 'contain', caption: 'A photo' } }).content.imageHeight, 480);
  assert.throws(() => model.normalizeWidget({ kind: 'image', content: { dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' } }), /base64 PNG/);
  assert.throws(() => model.normalizeWidget({ kind: 'image', content: { dataUrl: 'data:image/png;base64,PHN2Zz4=' } }), /signature/);
  assert.throws(() => model.normalizeWidget({ kind: 'image', content: { dataUrl: 'data:image/png;base64,iVBORw0KGgo===' } }), /base64/);
  assert.throws(() => model.normalizeWidget({ kind: 'image', content: { dataUrl: `data:image/png;base64,iVBORw0KGgo=${'A'.repeat(6 * 1024 * 1024)}` } }), /6 MiB/);
  assert.throws(() => model.normalizeWidget({ kind: 'image', content: { fit: 'stretch' } }), /fit is invalid/);
  assert.throws(() => model.normalizeWidget({ kind: 'image', content: { caption: 'c'.repeat(501) } }), /500/);
});

test('goal values clamp to their numeric domain and appearance overrides stay bounded', () => {
  const goal = model.normalizeWidget({
    kind: 'goal',
    content: { current: 1e20, target: 100, unit: 'km', progress: 'ring' },
    appearance: { textColor: '#12aBcD', backgroundColor: null, accentColor: '#ABCDEF', fontSize: 1, opacity: 0 },
  });
  assert.equal(goal.content.current, 1e12);
  assert.equal(goal.content.target, 100);
  assert.throws(() => model.normalizeWidget({ kind: 'goal', content: { target: 0 } }), /above zero/);
  assert.throws(() => model.normalizeWidget({ kind: 'goal', content: { target: -1 } }), /above zero/);
  assert.equal(model.normalizeWidget({ kind: 'goal', content: { target: Number.MIN_VALUE } }).content.target, Number.MIN_VALUE);
  assert.equal(goal.content.unit, 'km');
  assert.equal(goal.content.progress, 'ring');
  assert.equal(goal.appearance.textColor, '#12aBcD');
  assert.equal(goal.appearance.accentColor, '#ABCDEF');
  assert.equal(goal.appearance.fontSize, 12);
  assert.equal(goal.appearance.opacity, 0.2);
  assert.equal(model.normalizeWidget({ kind: 'goal', content: { current: 150, target: 100 } }).content.current, 150);
  assert.throws(() => model.normalizeWidget({ kind: 'goal', content: { current: NaN } }), /finite number/);
  assert.throws(() => model.normalizeWidget({ kind: 'goal', content: { unit: 'u'.repeat(41) } }), /40/);
  assert.throws(() => model.normalizeWidget({ kind: 'goal', content: { progress: 'pie' } }), /progress is invalid/);
});

test('store normalization enforces version and limits, filters corrupt records, and keeps IDs unique', () => {
  const store = model.normalizeStore({
    version: 1,
    ignored: 'drop',
    widgets: [
      { id: 'first', kind: 'text', content: { text: 'kept' } },
      { id: 'first', kind: 'goal' },
      { id: 'bad kind', kind: 'surprise' },
      null,
      { id: 'second', kind: 'goal', content: { current: Infinity } },
      { id: 'second', kind: 'goal' },
      { kind: 'image', content: { dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' } },
      { kind: 'countdown' },
    ],
  });
  assert.deepEqual(Object.keys(store), ['version', 'widgets']);
  assert.equal(store.version, 1);
  assert.equal(store.widgets.length, 3);
  assert.deepEqual(store.widgets.map((widget) => widget.id), ['first', 'second', store.widgets[2].id]);
  assert.equal(store.widgets[0].content.text, 'kept');
  assert.equal(store.widgets[1].kind, 'goal');
  assert.ok(store.widgets[2].kind === 'countdown');
  assert.equal(new Set(store.widgets.map((widget) => widget.id)).size, store.widgets.length);

  assert.deepEqual(model.normalizeStore({}), { version: 1, widgets: [] });
  assert.throws(() => model.normalizeStore({ version: 2, widgets: [] }), /unsupported/);
  assert.throws(() => model.normalizeStore({ version: '1', widgets: [] }), /unsupported/);
  assert.throws(() => model.normalizeStore({ widgets: {} }), /array/);
  assert.throws(() => model.normalizeStore({ widgets: Array.from({ length: 33 }, (_, index) => ({ id: `w${index}`, kind: 'goal' })) }), /at most 32/);
});

test('clampBounds keeps integer bounds reachable on monitors with negative origins', () => {
  assert.deepEqual(
    model.clampBounds({ x: 9000, y: -500, width: 900, height: 300 }, { x: -1920, y: 0, width: 1920, height: 1080 }),
    { x: -900, y: 0, width: 900, height: 300 },
  );
  assert.deepEqual(
    model.clampBounds({ x: -5000.7, y: 1000.2, width: 5000, height: 9999 }, { x: -1920, y: -100, width: 1920, height: 1080 }),
    { x: -1920, y: -100, width: 1920, height: 1080 },
  );
  const fractional = model.clampBounds({ x: -0.5, y: 7.6, width: 100.4, height: 99.5 }, { x: -200.2, y: -100.3, width: 400.4, height: 200.4 });
  assert.ok(Object.values(fractional).every(Number.isInteger));
  assert.ok(fractional.x >= -200 && fractional.x + fractional.width <= 200);
  assert.ok(fractional.y >= -100 && fractional.y + fractional.height <= 100);
  assert.equal(Object.is(model.clampBounds({ x: -0.5, y: -0.5, width: 1, height: 1 }, { x: -1, y: -1, width: 2, height: 2 }).x, -0), false);

  assert.deepEqual(
    model.clampBounds({ x: 500, y: 500, width: -20, height: 0 }, { x: 0, y: 0, width: 10, height: 8 }),
    { x: 9, y: 7, width: 1, height: 1 },
  );
  for (const bounds of [
    { x: NaN, y: 0, width: 10, height: 10 },
    { x: 0, y: 0, width: Infinity, height: 10 },
    { y: 0, width: 10, height: 10 },
  ]) {
    assert.throws(() => model.clampBounds(bounds, { x: 0, y: 0, width: 100, height: 100 }));
  }
  assert.throws(() => model.clampBounds({ x: 0, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 0, height: 100 }), /positive/);
});
