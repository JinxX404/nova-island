/* Nova Island — Settings › Widgets: manager + detached editor.
   Loaded by prefs/index.html after widgets/model.js and widgets/render.js,
   before prefs.js.
   Exposes window.WidgetSettings = { open(id?), refresh(), cancel(), isEditing() }. */
(() => {
  'use strict';

  const M = window.WidgetModel || null;
  const V = window.WidgetView || null;
  const api = window.prefs || {};

  // ---- contract constants (fallbacks only if the model is not ready) ----
  const KIND_LABEL = { text: 'Text', countdown: 'Countdown', links: 'Quick links', image: 'Image', goal: 'Goal' };
  const PRESET_LABEL = { note: 'Note', statement: 'Statement', label: 'Label' };
  const SIZE_PRESETS = (M && M.SIZE_PRESETS) || { compact: 220, medium: 320, wide: 480 };
  const MAX_WIDGETS = (M && M.MAX_WIDGETS) || 32;
  const MAX_LINKS = 24;
  const BASE_APPEARANCE = {
    fontSize: 18, fontWeight: 400, align: 'start', lineHeight: 1.5,
    textColor: null, backgroundColor: null, accentColor: null,
    opacity: 0.92, padding: 20, direction: 'auto',
  };
  const BASE_LAYOUT = { width: 320, height: 180, autoHeight: true };
  const FONT_STEPS = [12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 40, 48, 56, 72];
  const LINE_STEPS = [1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 2, 2.2, 2.5];
  const PAD_STEPS = [4, 8, 12, 16, 20, 24, 28, 32, 40, 48];
  const IMG_H_STEPS = [64, 96, 120, 160, 180, 220, 260, 320, 400, 480];
  const WEIGHTS = [[400, 'Regular'], [500, 'Medium'], [600, 'Semibold'], [700, 'Bold'], [800, 'Black']];
  const NEUTRAL = { textColor: '#ececf4', backgroundColor: '#23252e', accentColor: '#8cc8ff' };
  const COLOR_LABEL = { textColor: 'Text color', backgroundColor: 'Card color', accentColor: 'Accent color' };
  const ACTION_TOAST = { duplicate: 'Duplicated', delete: 'Removed', hide: 'Hidden', show: 'Shown', lock: 'Locked', unlock: 'Unlocked' };
  const ICONS = {
    text: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h11M4 18h7"/></svg>',
    countdown: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    links: '<svg viewBox="0 0 24 24"><path d="M10.5 13.5a5 5 0 0 0 7.3.4l2-2a5 5 0 0 0-7-7l-1.1 1.1"/><path d="M13.5 10.5a5 5 0 0 0-7.3-.4l-2 2a5 5 0 0 0 7 7l1.1-1.1"/></svg>',
    image: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="m5.5 19 5-5 3 3 2.5-2.5L19 17"/></svg>',
    goal: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4"/></svg>',
  };

  // ---- state ----
  let store = { version: 1, widgets: [] };
  let storeReady = false;
  let pendingOpen = null;
  let draft = null;
  let editingNew = false;
  let saving = false;
  let pickBusy = false;
  const ui = {};
  const ctrl = {};
  const sharedSync = [];  // sync fns for Appearance/Layout controls (built once)
  let contentSync = [];   // sync fns for the kind-specific Content controls
  const opBusy = new Set();

  // ---- tiny DOM helper (never innerHTML with user data) ----
  function dom(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v; // static trusted markup only
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else n.setAttribute(k, String(v));
    }
    for (const kid of kids.flat(9)) if (kid != null) n.append(kid);
    return n;
  }
  const clampNum = (v, lo, hi, fb) => {
    v = Number(v);
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb;
  };
  const round2 = (v) => Math.round(v * 100) / 100;

  // ---- status pill ----
  let statusTimer = null;
  function toast(text, bad = false) {
    if (!ui.status) return;
    ui.status.textContent = text;
    ui.status.classList.toggle('bad', !!bad);
    ui.status.classList.add('on');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => ui.status.classList.remove('on'), 2200);
  }

  // ---- preview scheduling ----
  let previewQueued = false;
  function schedulePreview() {
    if (previewQueued) return;
    previewQueued = true;
    requestAnimationFrame(() => { previewQueued = false; renderPreview(); });
  }
  function onChange() { schedulePreview(); }

  // ---- store ----
  function sanitizeStore(raw) {
    const list = Array.isArray(raw && raw.widgets) ? raw.widgets : [];
    const out = [];
    for (const w of list) {
      try { out.push(M && M.normalizeWidget ? M.normalizeWidget(w) : w); } catch { /* corrupt record filtered */ }
    }
    return { version: 1, widgets: out };
  }
  function syncStore(raw) {
    if (M && M.normalizeStore) { try { store = M.normalizeStore(raw); } catch { store = sanitizeStore(raw); } }
    else store = sanitizeStore(raw);
    if (!store || !Array.isArray(store.widgets)) store = { version: 1, widgets: [] };
    storeReady = true;
    renderList();
    if (draft && !editingNew && !store.widgets.some((w) => w.id === draft.id)) closeEditor('That widget was removed');
    if (pendingOpen != null) { const id = pendingOpen; pendingOpen = null; open(id); }
  }
  function refresh() {
    if (!api.widgets) return;
    Promise.resolve(api.widgets()).then(syncStore).catch(() => toast('Could not load widgets. Your saved data has been preserved.', true));
  }
  function mergeWidget(w) {
    if (!w || !w.id) { refresh(); return; }
    const i = store.widgets.findIndex((x) => x.id === w.id);
    if (i >= 0) store.widgets[i] = w; else store.widgets.push(w);
    renderList();
  }

  // ---- widget display helpers ----
  const kindTitle = (w) => KIND_LABEL[w && w.kind] || 'Widget';
  function displayTitle(w) {
    const c = (w && w.content) || {};
    const t = String(c.title || '').trim();
    if (t) return t;
    if (w && w.kind === 'text') { const b = String(c.text || '').trim(); if (b) return b.split('\n')[0].slice(0, 60); }
    return kindTitle(w);
  }
  function summaryText(w) {
    const l = w.layout || {};
    const size = `${clampNum(l.width, 180, 720, 320)} × ${l.autoHeight ? 'auto' : clampNum(l.height, 64, 800, 180)}`;
    const flags = [w.hidden ? 'hidden' : 'shown', w.locked ? 'locked' : ''].filter(Boolean).join(' · ');
    return flags ? `${size} · ${flags}` : size;
  }

  // ---- manager list ----
  function renderList() {
    if (!ui.rows) return;
    const focused = document.activeElement;
    const previousRow = focused?.closest('[data-wg-id]');
    const focusId = previousRow?.dataset.wgId;
    const focusIndex = previousRow ? [...previousRow.querySelectorAll('button, input')].indexOf(focused) : -1;
    ui.rows.replaceChildren();
    const list = store.widgets;
    if (!list.length) ui.rows.append(dom('div', { class: 'wg-empty', text: 'No widgets yet. Add one below.' }));
    for (const w of list) ui.rows.append(rowFor(w));
    const full = list.length >= MAX_WIDGETS;
    ui.addBtn.disabled = full;
    ui.limit.hidden = !full;
    ui.count.textContent = list.length ? `${list.length} of ${MAX_WIDGETS}` : '';
    if (ui.choose) ui.choose.querySelectorAll('.wg-addchip').forEach((b) => { b.disabled = full; });
    if (focusIndex >= 0) {
      const row = [...ui.rows.children].find((el) => el.dataset.wgId === focusId);
      (row?.querySelectorAll('button, input')[focusIndex] || ui.addBtn).focus({ preventScroll: true });
    }
  }

  function rowFor(w) {
    const rowEl = dom('div', { class: 'row', dataset: { wgId: w.id } });
    rowEl.append(dom('span', { class: 'wg-kind-ico', html: ICONS[w.kind] || ICONS.text, 'aria-hidden': 'true' }));
    const title = displayTitle(w);
    const txt = dom('div', { class: 'txt' }, dom('b', { text: `${kindTitle(w)} — ${title}` }), dom('small', { text: summaryText(w) }));
    rowEl.append(txt);
    const btns = dom('div', { class: 'btns' });
    btns.append(dom('button', {
      class: 'btn sm', type: 'button', text: 'Edit',
      'aria-label': `Edit ${title}`, onclick: () => open(w.id),
    }));
    btns.append(dom('button', {
      class: 'btn sm', type: 'button', text: 'Copy',
      'aria-label': `Duplicate ${title}`, onclick: () => doAction(w.id, 'duplicate'),
    }));
    const sw = dom('input', { type: 'checkbox', class: 'sw', 'aria-label': `Show ${title} on the desktop` });
    sw.checked = !w.hidden;
    sw.addEventListener('change', () => doAction(w.id, sw.checked ? 'show' : 'hide'));
    btns.append(sw);
    btns.append(dom('button', {
      class: 'btn sm', type: 'button', text: w.locked ? 'Unlock' : 'Lock',
      'aria-label': w.locked ? `Unlock ${title}` : `Lock ${title}`,
      onclick: () => doAction(w.id, w.locked ? 'unlock' : 'lock'),
    }));
    btns.append(dom('button', {
      class: 'btn sm danger', type: 'button', text: '✕', 'aria-label': `Remove ${title}`,
      onclick: () => doAction(w.id, 'delete'),
    }));
    rowEl.append(btns);
    return rowEl;
  }

  async function doAction(id, action, btn) {
    const key = `${id}:${action}`;
    if (opBusy.has(key)) return;
    opBusy.add(key);
    if (btn) btn.disabled = true;
    try {
      const res = await api.widgetAction(id, action);
      if (!res || !res.ok) { toast((res && res.error) || 'That did not work', true); refresh(); return; }
      if (action === 'delete') {
        store.widgets = store.widgets.filter((x) => x.id !== id);
        renderList();
      } else mergeWidget(res.widget);
      if (!res.widget) refresh();
      toast(ACTION_TOAST[action] || 'Done');
    } catch { toast('That did not work', true); refresh(); }
    finally { opBusy.delete(key); if (btn) btn.disabled = false; }
  }

  // ---- add chooser ----
  function toggleChoose(force) {
    if (store.widgets.length >= MAX_WIDGETS && force !== false) { toast(`Widget limit reached (${MAX_WIDGETS})`, true); return; }
    const show = force != null ? force : ui.choose.hidden;
    ui.choose.hidden = !show;
    ui.addBtn.textContent = show ? 'Close' : 'Add widget';
    ui.addBtn.setAttribute('aria-expanded', String(show));
    if (show) ui.choose.querySelector('.wg-addchip:not(:disabled)')?.focus();
  }

  function startNew(kind) {
    if (draft) closeEditor('');
    if (!M || !M.createWidget) { toast('Widgets are still loading — try again', true); return; }
    if (store.widgets.length >= MAX_WIDGETS) { toast(`Widget limit reached (${MAX_WIDGETS})`, true); return; }
    let w;
    try { w = M.createWidget(kind, kind === 'text' ? 'note' : undefined); } catch (e) { toast('Could not create that widget', true); return; }
    if (kind === 'text' && w.content) w.content.title = ''; // "Custom text" starts blank
    openEditor(w, true);
    ui.choose.hidden = true;
    ui.addBtn.textContent = 'Add widget';
    ui.addBtn.setAttribute('aria-expanded', 'false');
  }

  // ---- editor: open / close ----
  function open(id) {
    if (!ui.editor) return;
    if (id == null) { if (!draft) toggleChoose(false); return; }
    if (draft && !editingNew && draft.id === id) { focusEditor(); return; }
    const w = store.widgets.find((x) => x.id === id);
    if (!w) { toast('Widget not found', true); return; }
    if (draft) closeEditor('');
    let norm;
    try { norm = M && M.normalizeWidget ? M.normalizeWidget(w) : JSON.parse(JSON.stringify(w)); }
    catch { toast("This widget's data is damaged", true); return; }
    openEditor(norm, false);
  }

  function openEditor(widget, isNew) {
    draft = widget;
    editingNew = isNew;
    saving = false;
    ui.edName.textContent = isNew ? `New ${kindTitle(widget).toLowerCase()} widget` : `Edit ${displayTitle(widget)}`;
    buildContentControls();
    syncAllControls();
    showError('');
    ui.save.disabled = false;
    ui.cancel.disabled = false;
    ui.save.textContent = 'Save';
    ui.layoutCtrls.closest('fieldset').disabled = widget.locked;
    ui.lockHint.hidden = !widget.locked;
    ui.listGroup.hidden = true;
    ui.editor.hidden = false;
    renderPreview();
    (ctrl.first || ui.save).focus({ preventScroll: true });
    requestAnimationFrame(() => {
      if (draft !== widget) return;
      ui.editor.scrollIntoView();
    });
  }

  function focusEditor() {
    ui.editor.scrollIntoView();
    (ctrl.first || ui.save).focus({ preventScroll: true });
  }

  function cancelDraft() {
    if (!draft || saving) return;
    closeEditor('');
  }

  function closeEditor(msg) {
    const returnId = !editingNew && draft?.id;
    draft = null;
    editingNew = false;
    ui.editor.hidden = true;
    ui.listGroup.hidden = false;
    const row = returnId ? [...ui.rows.children].find((el) => el.dataset.wgId === returnId) : null;
    (row?.querySelector('button') || ui.addBtn).focus({ preventScroll: true });
    if (msg) toast(msg, true);
  }

  function showError(msg, field) {
    ui.error.hidden = !msg;
    ui.error.textContent = msg || '';
    document.querySelectorAll('#widgets .wg-bad').forEach((el) => {
      el.classList.remove('wg-bad');
      el.removeAttribute('aria-invalid');
    });
    if (msg && field) {
      field.classList.add('wg-bad');
      field.setAttribute('aria-invalid', 'true');
    }
  }

  // ---- shared control factories ----
  function segControl(opts) {
    const group = dom('div', { class: 'seg', role: 'radiogroup', 'aria-label': opts.aria });
    const btns = opts.options.map(([value, label]) => dom('button', {
      type: 'button', role: 'radio', 'aria-checked': 'false', text: label,
      onclick: () => { if (!draft) return; opts.set(value); ctl.sync(); onChange(); },
    }));
    group.append(...btns);
    group.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
      const i = btns.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      const j = e.key === 'Home' ? 0 : e.key === 'End' ? btns.length - 1
        : (i + (['ArrowLeft', 'ArrowUp'].includes(e.key) ? -1 : 1) + btns.length) % btns.length;
      btns[j].click(); btns[j].focus();
    });
    function sync() {
      btns.forEach((b, i) => {
        const selected = opts.get() === opts.options[i][0];
        b.setAttribute('aria-checked', String(selected)); b.tabIndex = selected ? 0 : -1;
      });
    }
    const ctl = { node: group, sync };
    return ctl;
  }

  function stepper(opts) {
    const minus = dom('button', { type: 'button', 'data-dir': '-1', 'aria-label': 'Less', text: '−' });
    const plus = dom('button', { type: 'button', 'data-dir': '1', 'aria-label': 'More', text: '+' });
    const out = dom('output');
    const node = dom('div', { class: 'stepper', role: 'group', 'aria-label': opts.aria }, minus, out, plus);
    node.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || !draft) return;
      const dir = b.dataset.dir === '1' ? 1 : -1;
      const v = opts.get();
      let next;
      if (opts.list) next = dir > 0 ? (opts.list.find((x) => x > v) ?? null) : ([...opts.list].reverse().find((x) => x < v) ?? null);
      else {
        next = round2(v + dir * opts.step);
        if (next < opts.min - 1e-9 || next > opts.max + 1e-9) next = null;
      }
      if (next == null) return;
      opts.set(next);
      ctl.sync();
      onChange();
    });
    function sync() {
      const v = opts.get();
      out.textContent = opts.fmt ? opts.fmt(v) : String(v);
      minus.disabled = stepTo(-1, v) == null;
      plus.disabled = stepTo(1, v) == null;
    }
    function stepTo(dir, v) {
      if (opts.list) return dir > 0 ? (opts.list.find((x) => x > v) ?? null) : ([...opts.list].reverse().find((x) => x < v) ?? null);
      const n = round2(v + dir * opts.step);
      return n < opts.min - 1e-9 || n > opts.max + 1e-9 ? null : n;
    }
    const ctl = { node, sync };
    return ctl;
  }

  function colorRow(labelText, key) {
    const input = dom('input', { type: 'color', 'aria-label': `${labelText} custom color` });
    const well = dom('label', { class: 'wg-cwell' }, input);
    const tag = dom('span', { class: 'wg-themetag', text: 'Theme' });
    const reset = dom('button', {
      class: 'btn wg-themebtn', type: 'button', text: 'Theme',
      'aria-label': `Reset ${labelText.toLowerCase()} to theme`,
      onclick: () => { if (!draft) return; draft.appearance[key] = null; ctl.sync(); onChange(); },
    });
    const set = dom('span', { class: 'wg-colorset' }, well, tag, reset);
    input.addEventListener('input', () => {
      if (!draft) return;
      draft.appearance[key] = input.value;
      ctl.sync();
      onChange();
    });
    function sync() {
      const v = draft && draft.appearance ? draft.appearance[key] : null;
      if (v) input.value = v; else input.value = NEUTRAL[key];
      tag.hidden = !!v;
      reset.hidden = !v;
    }
    const ctl = { node: set, sync };
    return ctl;
  }

  function textField(opts) {
    const input = dom('input', {
      class: 'wg-in', type: 'text', dir: 'auto', maxlength: String(opts.max || 200),
      spellcheck: 'false', autocomplete: 'off',
      placeholder: opts.placeholder || '',
      'aria-label': opts.aria || opts.label,
    });
    input.addEventListener('input', () => {
      if (!draft) return;
      opts.set(input.value);
      onChange();
    });
    function sync() {
      if (draft) input.value = opts.get() || '';
    }
    const ctl = { node: input, sync, input };
    return ctl;
  }

  // content-controls plumbing -------------------------------------------------
  function fsRow(labelText, node, extra) {
    const r = dom('div', { class: 'row' }, dom('b', { text: labelText }));
    if (node) r.append(node);
    if (extra) r.append(extra);
    return r;
  }
  function fsField(labelText, input, hint) {
    const f = dom('div', { class: 'wg-field' }, dom('b', { text: labelText }));
    if (input) f.append(input);
    if (hint) f.append(dom('small', { class: 'wg-hint2', text: hint }));
    return f;
  }

  // ---- Content controls (per kind, rebuilt for every draft) ----
  function buildContentControls() {
    contentSync = [];
    ui.contentCtrls.replaceChildren();
    if (!draft) return;
    const box = ui.contentCtrls;
    const reg = (ctl) => { contentSync.push(ctl.sync); return ctl; };
    const add = (node) => box.append(node);

    if (draft.kind === 'text') buildTextContent(box, reg, add);
    else if (draft.kind === 'countdown') buildCountdownContent(box, reg, add);
    else if (draft.kind === 'links') buildLinksContent(box, reg, add);
    else if (draft.kind === 'image') buildImageContent(box, reg, add);
    else if (draft.kind === 'goal') buildGoalContent(box, reg, add);
  }

  function bindText(ctl, get, set) {
    ctl.addEventListener('input', () => { if (draft) { set(ctl.value); onChange(); } });
    contentSync.push(() => { if (draft) ctl.value = get() || ''; });
    return ctl;
  }

  function buildTextContent(box, reg, add) {
    const preset = reg(segControl({
      aria: 'Text preset',
      options: ['note', 'statement', 'label'].map((p) => [p, PRESET_LABEL[p]]),
      get: () => (draft.content ? draft.content.preset : 'note'),
      set: (v) => applyPreset(v),
    }));
    const title = bindText(dom('input', {
      class: 'wg-in', type: 'text', dir: 'auto', maxlength: '200',
      spellcheck: 'false', autocomplete: 'off', placeholder: 'Title (optional)',
      'aria-label': 'Title',
    }), () => draft.content.title, (v) => { draft.content.title = v; });
    const body = dom('textarea', {
      class: 'wg-in', dir: 'auto', maxlength: '20000', spellcheck: 'false',
      placeholder: 'Your text…', 'aria-label': 'Text',
    });
    body.addEventListener('input', () => { if (draft) { draft.content.text = body.value; onChange(); } });
    contentSync.push(() => { if (draft) body.value = draft.content.text || ''; });
    ctrl.first = title;

    add(fsRow('Preset', preset.node));
    add(fsField('Title', title));
    add(fsField('Text', body));
    add(dom('div', { class: 'wg-hint', text: 'Bold **like this**, italic *like this*, lists with - or 1.' }));
    ctrl.textBody = body;
  }

  function applyPreset(p) {
    if (!draft || !draft.content) return;
    draft.content.preset = p;
    const a = draft.appearance, l = draft.layout;
    const setSeed = (overridesA, overridesL) => {
      Object.assign(a, JSON.parse(JSON.stringify(BASE_APPEARANCE)), overridesA || {});
      Object.assign(l, JSON.parse(JSON.stringify(BASE_LAYOUT)), overridesL || {});
    };
    if (p === 'statement') setSeed({ fontSize: 32, fontWeight: 600, align: 'center', padding: 28 });
    else if (p === 'label') setSeed({ fontSize: 16, padding: 8 }, { width: 220 });
    else setSeed({});
    if (p === 'note' && !String(draft.content.title || '').trim()) draft.content.title = 'Note';
    if (p === 'label') draft.content.title = ''; // the Label preset has no title
    syncAllControls();
    onChange();
  }

  function buildCountdownContent(box, reg, add) {
    const title = bindText(dom('input', {
      class: 'wg-in', type: 'text', dir: 'auto', maxlength: '200',
      spellcheck: 'false', autocomplete: 'off', placeholder: 'Event name',
      'aria-label': 'Event name',
    }), () => draft.content.title, (v) => { draft.content.title = v; });
    const target = dom('input', {
      class: 'wg-in', type: 'datetime-local', step: '60', spellcheck: 'false',
      'aria-label': 'Target date and time',
    });
    target.addEventListener('input', () => {
      if (!draft) return;
      const v = target.value;
      if (!v) { draft.content.target = ''; return; }
      const d = new Date(v);
      draft.content.target = Number.isNaN(d.getTime()) ? '' : d.toISOString();
      onChange();
    });
    contentSync.push(() => {
      if (!draft) return;
      const d = new Date(draft.content.target || '');
      target.value = Number.isNaN(d.getTime()) ? '' : toLocalStamp(d);
    });
    ctrl.targetInput = target;
    ctrl.first = title;
    const format = reg(segControl({
      aria: 'Countdown format',
      options: [['detailed', 'Days + time'], ['days', 'Days only'], ['date', 'Date']],
      get: () => (draft.content ? draft.content.format : 'detailed'),
      set: (v) => { draft.content.format = v; },
    }));
    add(fsField('Title', title));
    add(fsField('Date & time', target, 'Past events show as arrived.'));
    add(fsRow('Format', format.node));
  }

  function toLocalStamp(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function buildLinksContent(box, reg, add) {
    const title = bindText(dom('input', {
      class: 'wg-in', type: 'text', dir: 'auto', maxlength: '200',
      spellcheck: 'false', autocomplete: 'off', placeholder: 'Title (optional)',
      'aria-label': 'Title',
    }), () => draft.content.title, (v) => { draft.content.title = v; });
    const arrange = reg(segControl({
      aria: 'Link arrangement',
      options: [['list', 'List'], ['grid', 'Grid']],
      get: () => (draft.content ? draft.content.arrangement : 'list'),
      set: (v) => { draft.content.arrangement = v; },
    }));
    ctrl.first = title;
    ctrl.itemsBox = dom('div');
    ctrl.countNote = dom('small', { text: '' });
    add(fsField('Title', title));
    add(fsRow('Arrangement', arrange.node));
    add(fsField('Links', ctrl.itemsBox));
    const foot = dom('div', { class: 'wg-items-foot' });
    ctrl.addWebBtn = dom('button', { class: 'btn', type: 'button', text: '+ Website', 'aria-label': 'Add a website link', onclick: () => addLinkItem('website') });
    ctrl.addAppBtn = dom('button', { class: 'btn', type: 'button', text: '+ App', 'aria-label': 'Add an app link', onclick: () => addLinkItem('app') });
    foot.append(ctrl.addWebBtn, ctrl.addAppBtn, ctrl.countNote);
    add(foot);
    add(dom('div', { class: 'wg-hint', text: 'Up to 24 links. Apps are chosen with the Windows file picker.' }));
    renderLinkItems();
  }

  const newLinkId = () => `it-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

  function addLinkItem(type) {
    if (!draft || !draft.content) return;
    const items = draft.content.items || (draft.content.items = []);
    if (items.length >= MAX_LINKS) return;
    const item = { id: newLinkId(), label: '', icon: '', type, target: '' };
    if (type === 'app') {
      // app targets come from the native picker only
      chooseAppFor(item, true);
      return;
    }
    items.push(item);
    renderLinkItems();
    onChange();
    const rows = ctrl.itemsBox.querySelectorAll('.wg-linkit');
    rows[rows.length - 1]?.querySelector('.wg-in')?.focus();
  }

  async function chooseAppFor(item, isNew) {
    if (pickBusy || !draft) return;
    pickBusy = true;
    const selectedDraft = draft;
    const btn = ctrl.addAppBtn;
    if (btn) { btn.disabled = true; btn.textContent = 'Choosing…'; }
    try {
      const r = await api.pickWidgetApp();
      if (r && r.target && draft === selectedDraft) {
        item.target = r.target;
        if (!item.label || isNew) item.label = r.label || item.label || '';
        if (r.icon) item.icon = r.icon;
        if (isNew) (draft.content.items || (draft.content.items = [])).push(item);
        renderLinkItems();
        onChange();
      }
    } catch { if (draft === selectedDraft) showError('Could not choose that app. Select an application or shortcut.'); }
    finally {
      pickBusy = false;
      if (btn) { btn.disabled = false; btn.textContent = '+ App'; }
    }
  }

  function renderLinkItems() {
    const box = ctrl.itemsBox;
    if (!box || !draft) return;
    box.replaceChildren();
    const items = draft.content.items || [];
    items.forEach((item, i) => box.append(linkItemRow(item, i)));
    const full = items.length >= MAX_LINKS;
    if (ctrl.addWebBtn) ctrl.addWebBtn.disabled = full;
    if (ctrl.addAppBtn) ctrl.addAppBtn.disabled = full;
    if (ctrl.countNote) ctrl.countNote.textContent = `${items.length} / ${MAX_LINKS}`;
  }

  function linkItemRow(item, index) {
    const items = draft.content.items;
    const rowEl = dom('div', { class: 'wg-linkit', dataset: { linkId: item.id } });
    const labelIn = dom('input', {
      class: 'wg-in', type: 'text', dir: 'auto', maxlength: '100',
      spellcheck: 'false', autocomplete: 'off', placeholder: 'Name', 'aria-label': `Link ${index + 1} name`,
      dataset: { lbl: '' },
    });
    labelIn.addEventListener('input', () => { item.label = labelIn.value; onChange(); });
    labelIn.value = item.label;
    const icoIn = dom('input', {
      class: 'wg-in wg-ico-in', type: 'text', dir: 'auto', maxlength: '8',
      spellcheck: 'false', autocomplete: 'off', placeholder: '🙂', 'aria-label': `Link ${index + 1} icon (text or emoji)`,
    });
    icoIn.addEventListener('input', () => { item.icon = icoIn.value; onChange(); });
    icoIn.value = item.icon;

    const top = dom('div', { class: 'wg-linkit-top' }, icoIn, labelIn);
    const move = (dir) => {
      const j = index + dir;
      if (j < 0 || j >= items.length) return;
      [items[index], items[j]] = [items[j], items[index]];
      renderLinkItems();
      onChange();
      const again = ctrl.itemsBox.querySelector(`.wg-linkit[data-link-id="${CSS.escape(item.id)}"] button[data-mv="${dir > 0 ? 'down' : 'up'}"]`);
      again?.focus();
    };
    const btns = dom('div', { class: 'btns' });
    btns.append(
      dom('button', { class: 'wg-mini', type: 'button', 'data-mv': 'up', text: '↑', 'aria-label': `Move ${item.label || `link ${index + 1}`} up`, disabled: index === 0 ? '' : null, onclick: () => move(-1) }),
      dom('button', { class: 'wg-mini', type: 'button', 'data-mv': 'down', text: '↓', 'aria-label': `Move ${item.label || `link ${index + 1}`} down`, disabled: index === items.length - 1 ? '' : null, onclick: () => move(1) }),
      dom('button', { class: 'wg-mini danger', type: 'button', text: '✕', 'aria-label': `Remove ${item.label || `link ${index + 1}`}`, onclick: () => removeLinkItem(index) }),
    );
    top.append(btns);
    rowEl.append(top);

    const typeControl = segControl({
      aria: `Link ${index + 1} type`, options: [['website', 'Website'], ['app', 'App']],
      get: () => item.type,
      set: (value) => {
        if (item.type === value) return;
        item.type = value;
        item.target = ''; // targets differ per type; ask again
        buildTargetCell();
        onChange();
      },
    });
    const typeSeg = typeControl.node;
    typeControl.sync();

    const targetCell = dom('div', { class: 'wg-target' });
    function buildTargetCell() {
      targetCell.replaceChildren();
      if (item.type === 'website') {
        const url = dom('input', {
          class: 'wg-in', type: 'url', dir: 'ltr', spellcheck: 'false', autocomplete: 'off',
          placeholder: 'https://example.com', 'aria-label': `Link ${index + 1} website address`,
        });
        url.value = /^https?:\/\//i.test(item.target || '') ? item.target : '';
        url.addEventListener('input', () => { item.target = url.value.trim(); onChange(); });
        targetCell.append(url);
        ctrl[`url_${item.id}`] = url;
      } else {
        const path = dom('span', { class: 'wg-path', text: item.target || 'No app chosen' });
        if (item.target) path.title = item.target;
        const pick = dom('button', { class: 'btn sm', type: 'button', text: item.target ? 'Change…' : 'Choose…', 'aria-label': `Choose app for ${item.label || `link ${index + 1}`}` });
        pick.addEventListener('click', () => chooseAppFor(item, false));
        targetCell.append(path, pick);
      }
    }
    buildTargetCell();

    const mid = dom('div', { class: 'wg-linkit-mid' }, typeSeg, targetCell);
    rowEl.append(mid);
    return rowEl;
  }

  function removeLinkItem(index) {
    if (!draft || !draft.content) return;
    const items = draft.content.items || [];
    items.splice(index, 1);
    renderLinkItems();
    onChange();
    const rows = ctrl.itemsBox.querySelectorAll('.wg-linkit');
    if (rows.length) rows[Math.min(index, rows.length - 1)]?.querySelector('.wg-in')?.focus();
    else ctrl.addWebBtn?.focus();
  }

  function buildImageContent(box, reg, add) {
    ctrl.imgChoose = dom('button', { class: 'btn', type: 'button', text: 'Choose file…', 'aria-label': 'Choose an image file', onclick: () => pickImage() });
    ctrl.imgRemove = dom('button', { class: 'btn', type: 'button', text: 'Remove', 'aria-label': 'Remove the image', onclick: () => { if (draft && draft.content) { draft.content.dataUrl = ''; draft.content.name = ''; syncImageRow(); onChange(); } } });
    const zone = dom('div', { class: 'wg-imgrow' });
    ctrl.imgThumbWrap = dom('span');
    zone.append(ctrl.imgThumbWrap, ctrl.imgChoose, ctrl.imgRemove);
    const caption = bindText(dom('input', {
      class: 'wg-in', type: 'text', dir: 'auto', maxlength: '500',
      spellcheck: 'false', autocomplete: 'off', placeholder: 'Caption (optional)',
      'aria-label': 'Caption',
    }), () => draft.content.caption, (v) => { draft.content.caption = v; });
    ctrl.first = ctrl.imgChoose;
    const fit = reg(segControl({
      aria: 'Image fit',
      options: [['cover', 'Fill card'], ['contain', 'Fit inside']],
      get: () => (draft.content ? draft.content.fit : 'cover'),
      set: (v) => { draft.content.fit = v; },
    }));
    const h = reg(stepper({
      aria: 'Image height', list: IMG_H_STEPS,
      get: () => clampNum(draft.content.imageHeight, 64, 480, 180),
      set: (v) => { draft.content.imageHeight = v; },
      fmt: (v) => `${v} px`,
    }));
    add(zone);
    add(fsField('Caption', caption));
    add(fsRow('Fit', fit.node));
    add(fsRow('Image height', h.node));
    syncImageRow();
  }

  function syncImageRow() {
    if (!draft || !draft.content) return;
    ctrl.imgThumbWrap.replaceChildren();
    if (draft.content.dataUrl) {
      const img = dom('img', { class: 'wg-thumb', src: draft.content.dataUrl, alt: '' });
      ctrl.imgThumbWrap.append(img);
      ctrl.imgChoose.textContent = 'Replace…';
      ctrl.imgRemove.hidden = false;
    } else {
      ctrl.imgThumbWrap.append(dom('span', { class: 'wg-noimg', text: 'None', 'aria-hidden': 'true' }));
      ctrl.imgChoose.textContent = 'Choose file…';
      ctrl.imgRemove.hidden = true;
    }
  }

  async function pickImage() {
    if (!draft || pickBusy) return;
    pickBusy = true;
    const selectedDraft = draft;
    const btn = ctrl.imgChoose;
    btn.disabled = true;
    btn.textContent = 'Choosing…';
    try {
      const r = await api.pickWidgetImage();
      if (r && r.dataUrl && draft === selectedDraft) {
        draft.content.dataUrl = r.dataUrl;
        draft.content.name = r.name || '';
        syncImageRow();
        onChange();
      }
    } catch { if (draft === selectedDraft) showError('Choose a readable PNG, JPEG, GIF or WebP image smaller than 4 MiB.'); }
    finally {
      pickBusy = false;
      if (btn.isConnected) { btn.disabled = false; btn.textContent = draft?.content.dataUrl ? 'Replace…' : 'Choose file…'; }
    }
  }

  function buildGoalContent(box, reg, add) {
    const title = bindText(dom('input', {
      class: 'wg-in', type: 'text', dir: 'auto', maxlength: '200',
      spellcheck: 'false', autocomplete: 'off', placeholder: 'Goal name',
      'aria-label': 'Goal name',
    }), () => draft.content.title, (v) => { draft.content.title = v; });
    const current = dom('input', { class: 'wg-in wg-num', type: 'number', min: '0', step: '1', inputmode: 'numeric', spellcheck: 'false', 'aria-label': 'Current amount' });
    const target = dom('input', { class: 'wg-in wg-num', type: 'number', min: '0', step: '1', inputmode: 'numeric', spellcheck: 'false', 'aria-label': 'Target amount' });
    current.value = draft.content.current ?? 0;
    target.value = draft.content.target ?? '';
    current.addEventListener('input', () => {
      if (!draft) return;
      draft.content.current = current.value === '' ? 0 : clampNum(current.value, 0, 1e12, draft.content.current);
      onChange();
    });
    target.addEventListener('input', () => {
      if (!draft) return;
      draft.content.target = target.value === '' ? null : clampNum(target.value, 0, 1e12, draft.content.target);
      onChange();
    });
    ctrl.goalTarget = target;
    ctrl.first = title;
    const unit = bindText(dom('input', {
      class: 'wg-in', type: 'text', dir: 'auto', maxlength: '40',
      spellcheck: 'false', autocomplete: 'off', placeholder: 'Unit, e.g. pages',
      'aria-label': 'Unit',
    }), () => draft.content.unit, (v) => { draft.content.unit = v; });
    const progress = reg(segControl({
      aria: 'Progress style',
      options: [['bar', 'Bar'], ['ring', 'Ring']],
      get: () => (draft.content ? draft.content.progress : 'bar'),
      set: (v) => { draft.content.progress = v; },
    }));
    add(fsField('Title', title));
    const nums = fsRow('Progress', dom('span', { class: 'wg-numwrap' }, current, dom('span', { class: 'wg-themetag', text: 'of', 'aria-hidden': 'true' }), target));
    add(nums);
    add(fsField('Unit', unit));
    add(fsRow('Show as', progress.node));
  }

  // ---- Appearance + Layout (shared, built once) ----
  function buildAppearanceControls() {
    const box = ui.appearanceCtrls;
    const reg = (ctl) => { sharedSync.push(ctl.sync); return ctl; };
    const add = (labelText, ctl) => box.append(fsRow(labelText, ctl.node));
    add('Text size', reg(stepper({
      aria: 'Text size', list: FONT_STEPS,
      get: () => draft.appearance.fontSize, set: (v) => { draft.appearance.fontSize = v; },
      fmt: (v) => `${v} px`,
    })));
    add('Weight', reg(segControl({
      aria: 'Font weight', options: WEIGHTS,
      get: () => draft.appearance.fontWeight, set: (v) => { draft.appearance.fontWeight = v; },
    })));
    add('Alignment', reg(segControl({
      aria: 'Alignment', options: [['start', 'Start'], ['center', 'Center'], ['end', 'End']],
      get: () => draft.appearance.align, set: (v) => { draft.appearance.align = v; },
    })));
    add('Line spacing', reg(stepper({
      aria: 'Line spacing', list: LINE_STEPS,
      get: () => draft.appearance.lineHeight, set: (v) => { draft.appearance.lineHeight = v; },
      fmt: (v) => `× ${v}`,
    })));
    add('Text color', reg(colorRow('Text color', 'textColor')));
    add('Card color', reg(colorRow('Card color', 'backgroundColor')));
    add('Accent color', reg(colorRow('Accent color', 'accentColor')));
    add('Opacity', reg(stepper({
      aria: 'Card opacity', min: 0.2, max: 1, step: 0.02,
      get: () => draft.appearance.opacity, set: (v) => { draft.appearance.opacity = v; },
      fmt: (v) => `${Math.round(v * 100)}%`,
    })));
    add('Padding', reg(stepper({
      aria: 'Padding', list: PAD_STEPS,
      get: () => draft.appearance.padding, set: (v) => { draft.appearance.padding = v; },
      fmt: (v) => `${v} px`,
    })));
    add('Text direction', reg(segControl({
      aria: 'Text direction', options: [['auto', 'Auto'], ['ltr', 'LTR'], ['rtl', 'RTL']],
      get: () => draft.appearance.direction, set: (v) => { draft.appearance.direction = v; },
    })));
  }

  function buildLayoutControls() {
    const box = ui.layoutCtrls;
    const reg = (ctl) => { sharedSync.push(ctl.sync); return ctl; };
    const add = (labelText, ctl) => box.append(fsRow(labelText, ctl.node));

    ui.autoSw = dom('input', { type: 'checkbox', class: 'sw', 'aria-label': 'Auto height' });
    ui.autoSw.addEventListener('change', () => {
      if (!draft) return;
      draft.layout.autoHeight = ui.autoSw.checked;
      syncAllControls();
      onChange();
    });
    box.append(dom('label', { class: 'row' }, dom('b', { text: 'Auto height' }), ui.autoSw));

    const sizeSeg = reg(segControl({
      aria: 'Width',
      options: [
        ['compact', `Compact ${SIZE_PRESETS.compact}`],
        ['medium', `Medium ${SIZE_PRESETS.medium}`],
        ['wide', `Wide ${SIZE_PRESETS.wide}`],
        ['custom', 'Custom'],
      ],
      get: () => widthKind(),
      set: (v) => {
        draft.layout.width = v === 'custom' ? draft.layout.width : SIZE_PRESETS[v];
        syncAllControls();
      },
    }));
    add('Width', sizeSeg);

    ui.widthStep = reg(stepper({
      aria: 'Custom width', min: 180, max: 720, step: 10,
      get: () => clampNum(draft.layout.width, 180, 720, 320),
      set: (v) => { draft.layout.width = v; },
      fmt: (v) => `${v} px`,
    }));
    ui.widthRow = fsRow('', ui.widthStep.node);
    box.append(ui.widthRow);

    ui.heightStep = reg(stepper({
      aria: 'Height', min: 64, max: 800, step: 8,
      get: () => clampNum(draft.layout.height, 64, 800, 180),
      set: (v) => { draft.layout.height = v; },
      fmt: (v) => `${v} px`,
    }));
    ui.heightRow = fsRow('Height', ui.heightStep.node);
    box.append(ui.heightRow);

    const px = dom('input', { class: 'wg-in wg-num', type: 'number', step: '1', spellcheck: 'false', 'aria-label': 'Position from the left (optional)' });
    const py = dom('input', { class: 'wg-in wg-num', type: 'number', step: '1', spellcheck: 'false', 'aria-label': 'Position from the top (optional)' });
    px.addEventListener('input', () => { if (draft) { const v = Number(px.value); draft.position.x = px.value === '' ? draft.position.x : (Number.isFinite(v) ? Math.round(v) : draft.position.x); onChange(); } });
    py.addEventListener('input', () => { if (draft) { const v = Number(py.value); draft.position.y = py.value === '' ? draft.position.y : (Number.isFinite(v) ? Math.round(v) : draft.position.y); onChange(); } });
    ctrl.posX = px;
    ctrl.posY = py;
    const posWrap = dom('span', { class: 'wg-numwrap' }, px, py);
    add('Position (optional)', reg({
      node: posWrap,
      sync: () => {
        if (!draft) return;
        px.value = String(draft.position && draft.position.x != null ? draft.position.x : '');
        py.value = String(draft.position && draft.position.y != null ? draft.position.y : '');
      },
    }));
  }

  function widthKind() {
    const w = draft.layout.width;
    for (const [k, v] of Object.entries(SIZE_PRESETS)) if (v === w) return k;
    return 'custom';
  }

  function syncAllControls() {
    for (const s of contentSync) { try { s(); } catch { /* ignore */ } }
    for (const s of sharedSync) { try { s(); } catch { /* ignore */ } }
    if (ui.autoSw && draft) {
      ui.autoSw.checked = !!draft.layout.autoHeight;
      ui.widthRow.hidden = widthKind() !== 'custom';
      ui.heightRow.hidden = !!draft.layout.autoHeight;
    }
  }

  // ---- preview ----
  function renderPreview() {
    if (!draft || !ui.holder || !V) return;
    const card = dom('div', { class: 'widget-card' });
    try { V.render(card, draft, { onLink() {}, now: Date.now() }); }
    catch { card.textContent = 'Preview unavailable'; }
    try { V.applyAppearance(card, draft); } catch { /* appearance is cosmetic */ }
    ui.holder.replaceChildren(card);
    ui.holder.style.width = `${clampNum(draft.layout.width, 180, 720, 320)}px`;
    if (draft.layout.autoHeight) {
      ui.holder.style.height = '';
      ui.holder.style.overflowY = 'auto';
    } else {
      ui.holder.style.height = `${clampNum(draft.layout.height, 64, 800, 180)}px`;
      ui.holder.style.overflowY = 'auto';
    }
  }

  // ---- validation + save ----
  function validateDraft() {
    if (!draft) return null;
    const c = draft.content || {};
    if (draft.kind === 'countdown') {
      const bad = !c.target || Number.isNaN(new Date(c.target).getTime());
      if (bad) return { msg: 'Choose a date and time for the countdown.', field: ctrl.targetInput };
    }
    if (draft.kind === 'links') {
      const items = c.items || [];
      if (!items.length) return { msg: 'Add at least one link before saving.' };
      const rows = ctrl.itemsBox ? ctrl.itemsBox.querySelectorAll('.wg-linkit') : [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const rowEl = rows[i] || null;
        if (!String(it.label || '').trim()) return { msg: `Give link ${i + 1} a name.`, field: rowEl ? rowEl.querySelector('[data-lbl]') : null };
        let validWebsite = false;
        try { const u = new URL(it.target); validWebsite = /^https?:\/\//i.test(it.target) && ['https:', 'http:'].includes(u.protocol) && !!u.hostname && !u.username && !u.password && !/[\x00-\x20\x7f\\]/.test(it.target); } catch {}
        if (it.type === 'website' && !validWebsite) {
          return { msg: `Link ${i + 1}: use an http:// or https:// address without credentials or spaces.`, field: (ctrl[`url_${it.id}`]) || null };
        }
        if (it.type === 'app' && !String(it.target || '').trim()) return { msg: `Link ${i + 1}: choose an app with the picker.` };
      }
    }
    if (draft.kind === 'goal') {
      const t = Number(c.target);
      if (!Number.isFinite(t) || t <= 0) return { msg: 'Set a target above zero.', field: ctrl.goalTarget };
      if (!Number.isFinite(Number(c.current)) || Number(c.current) < 0) return { msg: "Current progress can't be negative." };
    }
    return null;
  }

  async function saveDraft() {
    if (!draft || saving || pickBusy) return;
    const problem = validateDraft();
    if (problem) { showError(problem.msg, problem.field); if (problem.field) problem.field.focus(); return; }
    saving = true;
    ui.save.disabled = true;
    ui.cancel.disabled = true;
    ui.save.textContent = 'Saving…';
    ui.editor.querySelectorAll('fieldset').forEach((el) => { el.disabled = true; });
    showError('');
    try {
      const payload = M && M.normalizeWidget ? M.normalizeWidget(draft) : draft;
      const res = await api.saveWidget(payload);
      if (!res || !res.ok) {
        showError((res && res.error) || 'Could not save the widget.');
        return;
      }
      const savedW = res.widget || payload;
      mergeWidget(savedW);
      closeEditor('');
      toast('Saved');
      refresh();
    } catch {
      showError('Could not save the widget.');
    } finally {
      saving = false;
      ui.editor.querySelectorAll('fieldset').forEach((el) => { el.disabled = !!draft?.locked && el.contains(ui.layoutCtrls); });
      if (draft) { // editor still open (a validation error kept it up)
        ui.save.disabled = false;
        ui.cancel.disabled = false;
        ui.save.textContent = 'Save';
      }
    }
  }

  // ---- page build ----
  function build() {
    const host = document.getElementById('widgets');
    if (!host) return;
    if (!host.querySelector('h1')) {
      host.append(
        dom('h1', { text: 'Widgets' }),
        dom('p', { class: 'lead', text: 'Little cards that live on your desktop, next to the island.' }),
      );
    }

    // manager list group
    ui.listGroup = dom('div', { class: 'group' });
    const headRow = dom('h2', { text: 'Your widgets' });
    ui.count = dom('span', { class: 'wg-count', text: '' });
    headRow.append(ui.count);
    ui.rows = dom('div', { class: 'card', id: 'wg-rows' });
    ui.limit = dom('p', { class: 'hint wg-limit', text: `Widget limit reached (${MAX_WIDGETS}). Remove one to add another.`, hidden: '' });
    ui.addBtn = dom('button', { class: 'btn accent', type: 'button', id: 'wg-add', text: 'Add widget', 'aria-expanded': 'false', 'aria-controls': 'wg-choose', onclick: () => toggleChoose() });
    ui.choose = dom('div', { class: 'wg-choose', id: 'wg-choose', hidden: '' });
    const kinds = ['text', 'countdown', 'links', 'image', 'goal'];
    for (const k of kinds) {
      ui.choose.append(dom('button', {
        class: 'wg-addchip', type: 'button', html: `${ICONS[k] || ''}<b>${k === 'text' ? 'Custom text' : KIND_LABEL[k]}</b>`,
        'aria-label': `Add a ${k === 'text' ? 'custom text' : KIND_LABEL[k].toLowerCase()} widget`,
        onclick: () => startNew(k),
      }));
    }
    const actions = dom('div', { class: 'actions' }, ui.addBtn);
    ui.listGroup.append(headRow, ui.rows, ui.choose, ui.limit, actions);
    host.append(ui.listGroup);

    // editor group
    ui.editor = dom('div', { class: 'group', id: 'wg-editor', hidden: '' });
    ui.edName = dom('h2', { text: '' });
    const view = dom('div', { class: 'wg-preview-view' });
    ui.holder = dom('div', { class: 'wg-holder' });
    view.append(ui.holder);
    const zone = dom('div', { class: 'wg-preview-zone' }, view, dom('small', { class: 'wg-preview-hint', text: 'Live preview — nothing is saved until you press Save.' }));

    const contentFs = dom('fieldset', { class: 'wg-fs' }, dom('legend', { text: 'Content' }));
    ui.contentCtrls = dom('div', { class: 'card' });
    contentFs.append(ui.contentCtrls);

    const appFs = dom('fieldset', { class: 'wg-fs' }, dom('legend', { text: 'Appearance' }));
    ui.appearanceCtrls = dom('div', { class: 'card' });
    appFs.append(ui.appearanceCtrls);

    const layoutFs = dom('fieldset', { class: 'wg-fs' }, dom('legend', { text: 'Layout' }));
    ui.layoutCtrls = dom('div', { class: 'card' });
    ui.lockHint = dom('p', { class: 'hint', text: 'Unlock this widget in the list to change its size or position.', hidden: '' });
    layoutFs.append(ui.lockHint, ui.layoutCtrls);

    ui.error = dom('p', { class: 'wg-error', role: 'alert', hidden: '' });
    ui.save = dom('button', { class: 'btn accent', type: 'button', text: 'Save', onclick: () => saveDraft() });
    ui.cancel = dom('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => cancelDraft() });
    const edActions = dom('div', { class: 'wg-edactions' }, ui.cancel, ui.save);
    ui.editor.append(ui.edName, zone, contentFs, appFs, layoutFs, ui.error, edActions);
    host.append(ui.editor);

    // status pill
    ui.status = dom('div', { class: 'wg-status', id: 'wg-status', role: 'status', 'aria-live': 'polite' });
    document.body.append(ui.status);

    buildAppearanceControls();
    buildLayoutControls();
    renderList();
  }

  // ---- events ----
  // Escape cancels the draft first; capture phase so it beats prefs.js's
  // "Escape closes Settings" handler regardless of registration order.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !draft) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    cancelDraft();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (!draft || saving || e.key !== 'Enter' || !e.ctrlKey) return;
    e.preventDefault();
    saveDraft();
  });

  function handleShowPage(page) {
    const p = String(page || '');
    if (p === 'widgets') { refresh(); return; }
    if (p.startsWith('widgets:')) {
      const id = p.slice('widgets:'.length).trim();
      if (!id) return;
      if (storeReady) open(id);
      else pendingOpen = id;
    }
  }

  // ---- public API ----
  window.WidgetSettings = {
    open,
    refresh,
    cancel: cancelDraft,
    isEditing: () => !!draft,
  };

  // ---- boot ----
  build();
  if (api.onWidgets) api.onWidgets(syncStore);
  function applyFeatures(f) {
    document.getElementById('widgets').dataset.theme = f.theme || 'original';
    document.body.classList.toggle('no-anim', !!f.noAnimations);
    document.getElementById('widgets').classList.toggle('widget-solid', !!f.noBlur);
    schedulePreview();
  }
  if (api.onFeatures) api.onFeatures(applyFeatures);
  if (api.features) api.features().then(applyFeatures).catch(() => {});
  if (api.onShowPage) api.onShowPage(handleShowPage);
  refresh();
})();
