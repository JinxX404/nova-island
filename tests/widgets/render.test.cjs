'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '../../widgets/render.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../../widgets/widgets.css'), 'utf8');
const view = require(sourcePath);
const model = require('../../widgets/model.js');

class StyleStub {
  constructor() {
    this.properties = new Map();
  }

  setProperty(name, value) {
    this.properties.set(name, String(value));
  }

  getPropertyValue(name) {
    return this.properties.get(name) || '';
  }
}

class NodeStub {
  constructor(document, tagName, text) {
    this.ownerDocument = document;
    this.tagName = tagName === '#text' ? '#text' : tagName.toUpperCase();
    this.nodeType = tagName === '#text' ? 3 : 1;
    this.children = [];
    this.attributes = Object.create(null);
    this.listeners = Object.create(null);
    this.style = new StyleStub();
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this._text = text || '';
    this._classes = new Set();
    this._className = '';
    this.classList = {
      add: (...names) => {
        names.forEach((name) => this._classes.add(name));
        this._syncClassName();
      },
      remove: (...names) => {
        names.forEach((name) => this._classes.delete(name));
        this._syncClassName();
      },
      contains: (name) => this._classes.has(name),
    };
  }

  get className() {
    return this._className;
  }

  set className(value) {
    this._className = String(value || '');
    this._classes = new Set(this._className.split(/\s+/).filter(Boolean));
  }

  _syncClassName() {
    this._className = Array.from(this._classes).join(' ');
  }

  get firstChild() {
    return this.children[0] || null;
  }

  get textContent() {
    if (this.nodeType === 3) return this._text;
    return this.children.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    if (this.nodeType === 3) {
      this._text = String(value);
      return;
    }
    this.replaceChildren();
    const text = String(value);
    if (text) this.appendChild(this.ownerDocument.createTextNode(text));
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  insertBefore(child, reference) {
    const index = this.children.indexOf(reference);
    if (index < 0) return this.appendChild(child);
    this.children.splice(index, 0, child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    return child;
  }

  replaceChildren(...children) {
    this.children = [];
    children.forEach((child) => this.appendChild(child));
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  addEventListener(name, listener) {
    (this.listeners[name] || (this.listeners[name] = [])).push(listener);
  }

  dispatch(name) {
    (this.listeners[name] || []).forEach((listener) => listener({ type: name, target: this }));
  }
}

const documentStub = {
  createElement(tagName) {
    return new NodeStub(documentStub, tagName);
  },
  createTextNode(text) {
    return new NodeStub(documentStub, '#text', String(text));
  },
};

function card() {
  return documentStub.createElement('div');
}

function descendants(node) {
  return node.children.flatMap((child) => [child, ...descendants(child)]);
}

function firstByClass(node, className) {
  return descendants(node).find((child) => child.classList.contains(className)) || null;
}

test('exports the same small API as CommonJS and the browser WidgetView global', () => {
  assert.deepEqual(Object.keys(view).sort(), ['applyAppearance', 'render']);
  assert.doesNotMatch(source, /\binnerHTML\b|\brequire\s*\(/);

  const browserWindow = {};
  vm.runInNewContext(source, { window: browserWindow });
  assert.equal(typeof browserWindow.WidgetView.render, 'function');
  assert.equal(typeof browserWindow.WidgetView.applyAppearance, 'function');
});

test('text renders optional titles, safe inline formatting, paragraphs, lists, and direction', () => {
  const widget = model.normalizeWidget({
    id: 'text-test',
    kind: 'text',
    content: {
      title: '',
      text: 'Hello **bold** and *italic*.\nA second line with <img src=x onerror=bad>.\n\n- one **item**\n- two\n1. first\n2. second',
    },
    appearance: { direction: 'rtl', align: 'end' },
  });
  const container = card();

  view.render(container, widget);

  assert.equal(container.classList.contains('widget-card'), true);
  assert.equal(container.getAttribute('dir'), 'rtl');
  assert.equal(container.getAttribute('aria-label'), 'Text widget');
  assert.equal(firstByClass(container, 'widget-title'), null);
  assert.equal(firstByClass(container, 'widget-paragraph').getAttribute('dir'), 'auto');
  assert.ok(firstByClass(container, 'widget-paragraph').children.some((child) => child.tagName === 'STRONG'));
  assert.ok(firstByClass(container, 'widget-paragraph').children.some((child) => child.tagName === 'EM'));
  assert.equal(descendants(container).filter((child) => child.tagName === 'UL').length, 1);
  assert.equal(descendants(container).filter((child) => child.tagName === 'OL').length, 1);
  assert.ok(descendants(container).filter((child) => child.tagName === 'LI').every((item) => item.getAttribute('dir') === 'auto'));
  assert.match(container.textContent, /<img src=x onerror=bad>/);
  assert.doesNotMatch(container.textContent, /\*\*bold\*\*|\*italic\*/);
  assert.equal(descendants(container).some((child) => child.tagName === 'IMG'), false);
});

test('appearance overrides stay independent and opacity is confined to background layers', () => {
  const container = card();
  const widget = model.normalizeWidget({
    id: 'appearance-test',
    kind: 'goal',
    appearance: {
      fontSize: 34, fontWeight: 700, align: 'center', lineHeight: 1.8,
      textColor: '#102030', backgroundColor: '#405060', accentColor: '#A0B0C0',
      opacity: 0.4, padding: 12, direction: 'ltr',
    },
  });

  view.applyAppearance(container, widget);

  assert.equal(container.style.getPropertyValue('--widget-font-size'), '34px');
  assert.equal(container.style.getPropertyValue('--widget-font-weight'), '700');
  assert.equal(container.style.getPropertyValue('--widget-align'), 'center');
  assert.equal(container.style.getPropertyValue('--widget-line-height'), '1.8');
  assert.equal(container.style.getPropertyValue('--widget-padding'), '12px');
  assert.equal(container.style.getPropertyValue('--widget-text-color'), '#102030');
  assert.equal(container.style.getPropertyValue('--widget-background'), '#405060');
  assert.equal(container.style.getPropertyValue('--widget-accent-color'), '#A0B0C0');
  assert.equal(container.style.getPropertyValue('--widget-opacity'), '0.4');
  assert.equal(container.getAttribute('dir'), 'ltr');
  assert.equal(container.style.getPropertyValue('opacity'), '');
  assert.match(css, /\.widget-card::before\s*\{[^}]*opacity:\s*var\(--widget-opacity/s);
  assert.match(css, /\.widget-goal-ring-hole::before\s*\{[^}]*opacity:\s*var\(--widget-opacity/s);
  assert.doesNotMatch(css, /font-size:\s*clamp\(/);
});

test('component styles stay widget-scoped, let the parent scroll, and keep large text at its chosen size', () => {
  const selectors = Array.from(css.matchAll(/([^{}]+)\{/g), (match) => match[1].trim());
  assert.ok(selectors.length > 0);
  for (const selectorGroup of selectors) {
    for (const selector of selectorGroup.split(',')) {
      assert.match(selector.trim(), /^\.widget-/);
    }
  }
  assert.doesNotMatch(css, /\.widget-card\s*\{[^}]*\n\s*height\s*:/s);
  assert.doesNotMatch(css, /\.widget-card\s*\{[^}]*\n\s*overflow\s*:/s);
  assert.match(css, /\.widget-card\s*\{[^}]*font-size:\s*var\(--widget-font-size\)/s);
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /grid-template-columns:\s*repeat\(auto-fit/);
  assert.match(css, /\.widget-card\s+\[hidden\]\s*\{\s*display:\s*none\s*!important/s);

  const container = card();
  view.render(container, model.normalizeWidget({
    id: 'large-text',
    kind: 'text',
    content: { title: 'Large', text: 'A long word that needs room: supercalifragilisticexpialidocious' },
    appearance: { fontSize: 72, direction: 'rtl' },
  }));
  assert.equal(container.style.getPropertyValue('--widget-font-size'), '72px');
  assert.equal(container.getAttribute('dir'), 'rtl');
});

test('countdowns show the selected date or remaining time and report events in the past', () => {
  const now = Date.parse('2035-08-09T00:00:00Z');
  const widget = model.normalizeWidget({
    id: 'countdown-test',
    kind: 'countdown',
    content: { title: 'Launch', target: '2035-08-10T03:04:05Z', format: 'detailed' },
  });
  const detailed = card();
  view.render(detailed, widget, { now });
  const detailedValue = firstByClass(detailed, 'widget-countdown-value');
  assert.match(detailedValue.textContent, /1 day/);
  assert.match(detailedValue.textContent, /3 hours/);
  assert.equal(detailedValue.getAttribute('datetime'), widget.content.target);
  assert.equal(detailedValue.getAttribute('role'), 'timer');

  const days = card();
  view.render(days, model.normalizeWidget({ ...widget, content: { ...widget.content, format: 'days' } }), { now });
  assert.match(firstByClass(days, 'widget-countdown-value').textContent, /2 days remaining/);

  const past = card();
  view.render(past, model.normalizeWidget({ ...widget, content: { ...widget.content, target: '2035-08-08T23:59:59Z' } }), { now });
  assert.equal(firstByClass(past, 'widget-countdown-arrived').textContent, 'Event has arrived.');
});

test('quick links render accessible buttons in the requested arrangement and report item indexes', () => {
  const widget = model.normalizeWidget({
    id: 'links-test',
    kind: 'links',
    content: {
      title: 'Shortcuts',
      arrangement: 'grid',
      items: [
        { id: 'site', label: 'Nova site', icon: '🌐', type: 'website', target: 'https://example.com' },
        { id: 'app', label: 'Editor', icon: '✎', type: 'app', target: 'C:\\Apps\\Editor.exe' },
      ],
    },
  });
  const clicked = [];
  const container = card();

  view.render(container, widget, { onLink: (index) => clicked.push(index) });

  assert.ok(firstByClass(container, 'widget-links').classList.contains('widget-links--grid'));
  const buttons = descendants(container).filter((child) => child.tagName === 'BUTTON');
  assert.equal(buttons.length, 2);
  assert.deepEqual(buttons.map((button) => button.getAttribute('aria-label')), ['Nova site', 'Editor']);
  assert.equal(buttons[0].type, 'button');
  assert.ok(firstByClass(buttons[0], 'widget-link-icon'));
  buttons[0].dispatch('click');
  buttons[1].dispatch('click');
  assert.deepEqual(clicked, [0, 1]);
  assert.equal(descendants(container).some((child) => child.tagName === 'A'), false);
  assert.doesNotMatch(container.textContent, /https:\/\/example\.com|Editor\.exe/);

  const preview = card();
  view.render(preview, widget);
  assert.equal(descendants(preview).find((child) => child.tagName === 'BUTTON').disabled, true);
});

test('images constrain sources, honor fit and height, and expose a load-error fallback', () => {
  const widget = model.normalizeWidget({
    id: 'image-test',
    kind: 'image',
    content: {
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      name: 'sunset.png', caption: 'Evening sky', fit: 'contain', imageHeight: 220,
    },
  });
  const container = card();

  view.render(container, widget);

  const image = descendants(container).find((child) => child.tagName === 'IMG');
  const fallback = firstByClass(container, 'widget-image-fallback');
  assert.equal(image.src, widget.content.dataUrl);
  assert.equal(image.alt, 'Evening sky');
  assert.equal(image.style.objectFit, 'contain');
  assert.equal(image.style.getPropertyValue('--widget-image-height'), '220px');
  assert.equal(fallback.hidden, true);
  image.dispatch('error');
  assert.equal(image.hidden, true);
  assert.equal(fallback.hidden, false);
  assert.match(container.textContent, /Evening sky/);

  const invalid = card();
  view.render(invalid, model.normalizeWidget({ id: 'empty-image', kind: 'image', content: { dataUrl: '' } }));
  assert.equal(descendants(invalid).some((child) => child.tagName === 'IMG'), false);
  assert.equal(firstByClass(invalid, 'widget-image-fallback').textContent, 'No image selected.');
});

test('goal bars and rings expose bounded progress semantics while keeping the actual total', () => {
  const bar = card();
  view.render(bar, model.normalizeWidget({
    id: 'bar-goal', kind: 'goal', content: { title: 'Distance', current: 150, target: 100, unit: 'km', progress: 'bar' },
  }));
  const barTrack = firstByClass(bar, 'widget-goal-bar');
  assert.equal(barTrack.getAttribute('role'), 'progressbar');
  assert.equal(barTrack.getAttribute('aria-valuemin'), '0');
  assert.equal(barTrack.getAttribute('aria-valuemax'), '100');
  assert.equal(barTrack.getAttribute('aria-valuenow'), '100');
  assert.equal(barTrack.style.getPropertyValue('--widget-progress'), '100%');
  assert.match(bar.textContent, /150 \/ 100 km/);

  const ring = card();
  view.render(ring, model.normalizeWidget({
    id: 'ring-goal', kind: 'goal', content: { title: 'Reading', current: 3, target: 10, progress: 'ring' },
  }));
  const ringTrack = firstByClass(ring, 'widget-goal-ring');
  assert.equal(ringTrack.getAttribute('role'), 'progressbar');
  assert.equal(ringTrack.getAttribute('aria-valuenow'), '30');
  assert.equal(ringTrack.style.getPropertyValue('--widget-progress'), '30%');
  assert.equal(firstByClass(ring, 'widget-goal-percent').textContent, '30%');

  const tiny = card();
  view.render(tiny, model.normalizeWidget({
    id: 'tiny-goal', kind: 'goal', content: { current: 0, target: Number.MIN_VALUE, progress: 'bar' },
  }));
  assert.match(firstByClass(tiny, 'widget-goal-summary').textContent, /4\.94e-324/i);
});
