(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./model'));
  else root.WidgetInlineEditor = factory(root.WidgetModel);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Model) {
  'use strict';
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const names = { text: 'text', countdown: 'countdown', links: 'quick links', image: 'image', goal: 'goal' };

  function prepareContent(widget, content) {
    if (widget.kind === 'goal') {
      if (typeof content.current !== 'number' || !Number.isFinite(content.current) || content.current < 0) throw new Error('Current amount must be zero or more.');
      if (typeof content.target !== 'number' || !Number.isFinite(content.target) || content.target <= 0) throw new Error('Set a target above zero.');
    }
    if (widget.kind === 'countdown' && (!content.target || !Number.isFinite(new Date(content.target).getTime()))) throw new Error('Choose a valid target date and time.');
    return Model.normalizeWidget({ ...widget, content: clone(content) }).content;
  }

  function mount(host, widget, options = {}) {
    const doc = host.ownerDocument;
    let draft = clone(widget.content);
    let busy = false, alive = true;
    function el(tag, cls, text) {
      const node = doc.createElement(tag);
      if (cls) node.className = cls;
      if (text !== undefined) node.textContent = text;
      return node;
    }
    function button(text, fn) {
      const b = el('button', '', text); b.type = 'button';
      b.addEventListener('click', fn);
      return b;
    }
    const form = el('form', 'widget-inline-editor');
    form.setAttribute('aria-label', `Edit ${names[widget.kind] || 'widget'} content`);
    const heading = el('h2', '', `Edit ${names[widget.kind] || 'widget'}`);
    const fields = el('fieldset', 'wie-fields');
    const legend = el('legend', 'wie-sr', 'Content'); fields.append(legend);
    const previewDetails = el('details', 'wie-preview');
    const preview = el('article', 'widget-card');
    previewDetails.append(el('summary', '', 'Preview'), preview);
    const message = el('p', 'wie-error'); message.setAttribute('role', 'alert'); message.hidden = true;
    const save = el('button', 'wie-save', 'Save'); save.type = 'submit';
    const cancel = button('Cancel', () => { if (!busy) options.onCancel?.(); });
    const actions = el('div', 'wie-actions'); actions.append(cancel, save);
    form.append(heading, fields, previewDetails, message, actions);
    host.replaceChildren(form);

    function showError(text) { message.textContent = text || ''; message.hidden = !text; }
    function changed() {
      if (!alive) return;
      const view = doc.defaultView?.WidgetView;
      view?.render(preview, { ...widget, content: clone(draft) });
      options.onChange?.();
    }
    function field(label, node, parent = fields) {
      const row = el('label', 'wie-field');
      node.setAttribute('aria-label', label);
      row.append(el('span', '', label), node); parent.append(row);
      return node;
    }
    function text(label, key, max = 200, parent = fields, object = draft, multiline = false) {
      const input = el(multiline ? 'textarea' : 'input');
      if (!multiline) input.type = 'text';
      input.dir = 'auto'; input.maxLength = max; input.value = object[key] || '';
      if (multiline) input.rows = 5;
      input.addEventListener('input', () => { object[key] = input.value; changed(); });
      return field(label, input, parent);
    }
    function number(label, key, min, max, parent = fields) {
      const input = el('input'); input.type = 'number'; input.min = min; input.max = max; input.step = 'any';
      input.value = draft[key]; input.inputMode = 'decimal';
      input.addEventListener('input', () => { draft[key] = input.value === '' ? null : Number(input.value); changed(); });
      return field(label, input, parent);
    }
    function select(label, key, values, parent = fields) {
      const input = el('select');
      for (const [value, name] of values) { const o = el('option', '', name); o.value = value; input.append(o); }
      input.value = draft[key];
      input.addEventListener('change', () => { draft[key] = input.value; changed(); });
      return field(label, input, parent);
    }
    function pending(on) {
      busy = on; fields.disabled = on; save.disabled = cancel.disabled = on;
      form.setAttribute('aria-busy', String(on));
    }
    async function pick(callback, apply) {
      if (busy) return;
      pending(true); showError('');
      try { const value = await callback?.(); if (alive && value) { apply(value); changed(); } }
      catch (error) { if (alive) showError(error.message || 'Could not choose this file.'); }
      finally { if (alive) pending(false); }
    }

    if (widget.kind === 'text') {
      text('Title', 'title');
      text('Text', 'text', 20000, fields, draft, true);
      fields.append(el('p', 'wie-hint', '**bold**, *italic* and lines starting with - for lists.'));
    } else if (widget.kind === 'countdown') {
      text('Event name', 'title');
      const date = el('input'); date.type = 'datetime-local'; date.step = '60'; date.required = true;
      const target = new Date(draft.target);
      if (Number.isFinite(target.getTime())) date.value = new Date(target.getTime() - target.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      date.addEventListener('input', () => {
        const parsed = new Date(date.value);
        draft.target = Number.isFinite(parsed.getTime()) ? parsed.toISOString() : '';
        changed();
      });
      field('Target date and time', date);
      select('Display format', 'format', [['detailed', 'Days, hours and minutes'], ['days', 'Days only'], ['date', 'Target date']]);
    } else if (widget.kind === 'goal') {
      text('Goal name', 'title');
      const row = el('div', 'wie-pair'); fields.append(row);
      number('Current amount', 'current', 0, 1e12, row);
      number('Target amount', 'target', 0.000001, 1e12, row);
      text('Unit', 'unit', 40);
      select('Show as', 'progress', [['bar', 'Bar'], ['ring', 'Ring']]);
    } else if (widget.kind === 'image') {
      const name = el('span', 'wie-hint', draft.name || 'No image selected');
      fields.append(button('Choose image…', () => pick(options.onPickImage, (value) => {
        draft.dataUrl = value.dataUrl; draft.name = value.name || ''; name.textContent = draft.name;
      })), name);
      text('Caption', 'caption', 500);
      select('Image fit', 'fit', [['cover', 'Crop to fill'], ['contain', 'Fit inside']]);
      number('Image height', 'imageHeight', 64, 480);
    } else if (widget.kind === 'links') {
      text('Title', 'title');
      select('Arrangement', 'arrangement', [['list', 'List'], ['grid', 'Grid']]);
      const list = el('div', 'wie-links'); fields.append(list);
      const add = button('Add website', () => {
        if (draft.items.length >= 24) return;
        draft.items.push({ id: `link-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, label: '', icon: '', type: 'website', target: '' });
        rows(); changed(); list.lastElementChild?.querySelector('input')?.focus();
      });
      const app = button('Add app…', () => pick(options.onPickApp, (value) => {
        if (draft.items.length >= 24) return;
        draft.items.push({ id: `link-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, label: value.label || '', icon: '', type: 'app', target: value.target });
        rows();
      }));
      const addRow = el('div', 'wie-pair'); addRow.append(add, app); fields.append(addRow);
      function rows() {
        list.replaceChildren();
        draft.items.forEach((item, index) => {
          const row = el('div', 'wie-link');
          row.append(el('b', '', `${item.type === 'app' ? 'App' : 'Website'} ${index + 1}`));
          text(`Link ${index + 1} name`, 'label', 100, row, item);
          text(`Link ${index + 1} icon`, 'icon', 16, row, item);
          if (item.type === 'app') {
            const path = el('p', 'wie-path', item.target); path.dir = 'auto'; row.append(path);
            row.append(button(`Choose app ${index + 1}…`, () => pick(options.onPickApp, (value) => { item.target = value.target; path.textContent = value.target; })));
          } else text(`Link ${index + 1} website address`, 'target', 2048, row, item);
          row.append(button(`Remove link ${index + 1}`, () => { draft.items.splice(index, 1); rows(); changed(); add.focus(); }));
          list.append(row);
        });
        add.disabled = app.disabled = draft.items.length >= 24;
      }
      rows();
    }
    form.addEventListener('submit', async (event) => {
      event.preventDefault(); if (busy) return;
      showError('');
      let content;
      try { content = prepareContent(widget, draft); }
      catch (error) { showError(error.message); return; }
      pending(true);
      try {
        const result = await options.onSave(content);
        if (alive && result && !result.ok) showError(result.error || 'Could not save this widget.');
      } catch (error) { if (alive) showError(error.message || 'Could not save this widget.'); }
      finally { if (alive) pending(false); }
    });
    form.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) options.onCancel?.(); }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); if (!busy) form.requestSubmit(); }
    });
    changed();
    return {
      focus() { fields.querySelector('input, textarea, select, button')?.focus(); },
      destroy() { alive = false; form.remove(); },
    };
  }
  return Object.freeze({ mount, prepareContent });
});
