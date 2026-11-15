(() => {
  'use strict';
  const api = window.widget;
  const $ = (id) => document.getElementById(id);
  let state = null, drag = null, countdown = null, measureFrame = null, lastMeasure = 0;
  let pendingGeometry = null, geometryBusy = false, optimisticGeometry = null;
  let measureContext = '', contentKey = '', inlineEditor = null, openingEditor = false;
  let keyboardMoving = false, lastDrag = -1000;
  const interactive = 'button,a,input,textarea,select,label,summary,details,[contenteditable]';

  function error(message) {
    $('error').textContent = message || '';
    $('error').hidden = !message;
  }
  async function action(name) {
    try {
      const result = await api.action(name);
      if (result && !result.ok) error(result.error);
      return result;
    } catch { error('Could not update this widget.'); return { ok: false }; }
  }
  function measure() {
    cancelAnimationFrame(measureFrame);
    measureFrame = requestAnimationFrame(() => {
      if (!state?.widget.layout.autoHeight || inlineEditor || openingEditor || state.inlineEditing) return;
      const shell = getComputedStyle($('shell'));
      const height = Math.ceil($('card').getBoundingClientRect().height + parseFloat(shell.paddingTop) + parseFloat(shell.paddingBottom));
      if (height !== lastMeasure) { lastMeasure = height; api.measure(height); }
    });
  }
  function goalControls() {
    const row = document.createElement('div'); row.className = 'goal-controls';
    row.setAttribute('role', 'group'); row.setAttribute('aria-label', 'Update goal progress');
    for (const [id, label, text, delta] of [['goal-minus', 'Decrease progress by one', '−', -1], ['goal-edit', 'Set goal progress', 'Update', 0], ['goal-plus', 'Increase progress by one', '+', 1]]) {
      const button = document.createElement('button'); button.id = id; button.type = 'button';
      button.textContent = text; button.setAttribute('aria-label', label);
      if (delta < 0) button.disabled = state.widget.content.current <= 0;
      button.addEventListener('click', async () => {
        if (!delta) { void beginInline(); return; }
        try { const result = await api.adjustGoal(delta); if (!result.ok) error(result.error); }
        catch { error('Could not update goal progress.'); }
      });
      row.append(button);
    }
    $('card').append(row);
  }
  function content() {
    const focus = $('card').contains(document.activeElement) ? document.activeElement.id : '';
    window.WidgetView.render($('card'), state.widget, { onLink: (index) => {
      api.openLink(index).then((r) => { if (r && !r.ok) error(r.error); }).catch(() => error('Could not open this link.'));
    } });
    $('card').querySelectorAll('img').forEach((img) => { img.draggable = false; });
    if (state.widget.kind === 'goal') goalControls();
    if (focus) { const target = $(focus); if (target && !target.disabled) target.focus(); else if (focus.startsWith('goal-')) $('goal-edit')?.focus(); }
    measure();
  }
  function update(next) {
    state = next;
    if (!state?.widget) return;
    const context = JSON.stringify([state.widget.position, state.widget.layout.width, state.widget.layout.autoHeight, state.inlineEditing, state.workArea]);
    if (context !== measureContext) { lastMeasure = 0; measureContext = context; }
    document.body.dataset.theme = state.features?.theme || 'original';
    document.body.classList.toggle('no-anim', !!state.features?.noAnimations);
    document.body.classList.toggle('widget-solid', !!state.features?.noBlur);
    document.body.classList.toggle('locked', !!state.widget.locked);
    $('resize').hidden = !!state.widget.locked;
    if (state.widget.locked && document.activeElement === $('resize')) $('menu').focus();
    if (state.widget.locked) { drag = null; pendingGeometry = null; optimisticGeometry = null; moveMode(false); }
    clearInterval(countdown);
    const nextKey = JSON.stringify([state.widget.kind, state.widget.content, state.widget.appearance]);
    if (nextKey !== contentKey && !inlineEditor && !openingEditor) { contentKey = nextKey; content(); }
    else measure();
    if (state.widget.kind === 'countdown' && !inlineEditor && !openingEditor) countdown = setInterval(content, 1000);
  }
  async function flushGeometry() {
    if (geometryBusy || !pendingGeometry) return;
    const patch = pendingGeometry; pendingGeometry = null; geometryBusy = true;
    try { const result = await api.geometry(patch); if (result && !result.ok) error(result.error); }
    catch { error('Could not change the layout.'); }
    finally { geometryBusy = false; if (pendingGeometry) void flushGeometry(); else optimisticGeometry = null; }
  }
  function geometry(patch) {
    optimisticGeometry = { ...state.widget.position, ...state.widget.layout, ...optimisticGeometry, ...patch };
    pendingGeometry = { ...pendingGeometry, ...patch };
    requestAnimationFrame(flushGeometry);
  }
  async function beginInline() {
    if (!state?.widget || inlineEditor || openingEditor) return;
    openingEditor = true; drag = null; moveMode(false); clearInterval(countdown); error('');
    try {
      const result = await api.editor(true);
      if (!result.ok) { error(result.error); return; }
      document.body.classList.add('inline-editing'); $('inline').hidden = false;
      inlineEditor = window.WidgetInlineEditor.mount($('inline'), state.widget, {
        onSave: async (draft) => {
          const saved = await api.content(draft);
          if (saved.ok) await closeInline();
          return saved;
        },
        onCancel: () => { void closeInline().catch(() => error('Could not close the editor.')); },
        onPickImage: () => api.pickImage(), onPickApp: () => api.pickApp(),
      });
      inlineEditor.focus();
    } catch {
      inlineEditor?.destroy(); inlineEditor = null;
      document.body.classList.remove('inline-editing'); $('inline').hidden = true;
      error('Could not open the content editor.'); await api.editor(false).catch(() => {});
    }
    finally { openingEditor = false; }
  }
  async function closeInline() {
    const result = await api.editor(false);
    if (!result.ok) throw new Error(result.error);
    inlineEditor?.destroy(); inlineEditor = null;
    document.body.classList.remove('inline-editing'); $('inline').hidden = true;
    contentKey = ''; lastMeasure = 0; update(state); $('menu').focus();
  }
  function moveMode(on) {
    keyboardMoving = on && !state?.widget.locked;
    $('move-hint').hidden = !keyboardMoving;
    document.body.classList.toggle('keyboard-moving', keyboardMoving);
    if (keyboardMoving) $('scroll').focus();
  }
  async function menu() {
    if (inlineEditor || openingEditor) return;
    drag = null;
    const result = await action('menu');
    if (result?.action === 'inline-edit') void beginInline();
    if (result?.action === 'keyboard-move') moveMode(true);
  }
  $('menu').addEventListener('click', menu);
  $('shell').addEventListener('contextmenu', (event) => {
    if (inlineEditor || event.target.closest('input,textarea,[contenteditable]')) return;
    event.preventDefault(); void menu();
  });
  $('scroll').addEventListener('dblclick', (event) => {
    if (!event.target.closest(interactive) && performance.now() - lastDrag > 250) void beginInline();
  });
  function startDrag(mode, button, event) {
    if (event.button !== 0 || state?.widget.locked || inlineEditor || openingEditor) return;
    if (mode === 'move' && event.target.closest(interactive)) return;
    if (mode === 'move') {
      const r = button.getBoundingClientRect();
      if (event.clientX < r.left + button.clientLeft || event.clientX >= r.left + button.clientLeft + button.clientWidth) return;
    }
    button.setPointerCapture(event.pointerId);
    drag = { mode, pointerId: event.pointerId, x: event.screenX, y: event.screenY, moved: false,
      start: { ...state.widget.position, ...state.widget.layout, height: window.innerHeight } };
    error('');
    if (mode === 'resize') event.preventDefault();
  }
  for (const [mode, button] of [['move', $('scroll')], ['resize', $('resize')]]) {
    button.addEventListener('pointerdown', (event) => startDrag(mode, button, event));
    button.addEventListener('pointermove', (event) => {
      if (!drag || drag.mode !== mode || drag.pointerId !== event.pointerId) return;
      const dx = event.screenX - drag.x, dy = event.screenY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true; document.body.classList.add('dragging'); event.preventDefault();
      geometry(mode === 'move' ? { x: drag.start.x + dx, y: drag.start.y + dy }
        : { width: drag.start.width + dx, height: drag.start.height + dy });
    });
    const end = () => {
      if (drag?.moved) lastDrag = performance.now();
      drag = null; document.body.classList.remove('dragging'); void flushGeometry();
    };
    button.addEventListener('pointerup', end); button.addEventListener('pointercancel', end); button.addEventListener('lostpointercapture', end);
  }
  document.addEventListener('keydown', (event) => {
    if (inlineEditor || openingEditor || event.target.closest('input,textarea,select,[contenteditable]')) return;
    if (event.key === 'F2') { event.preventDefault(); void beginInline(); return; }
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); void menu(); return; }
    if ((event.key === 'Escape' || event.key === 'Enter') && keyboardMoving) { event.preventDefault(); moveMode(false); $('menu').focus(); return; }
    const resizing = event.target === $('resize');
    if (state?.widget.locked || (!resizing && !keyboardMoving && !event.altKey) || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 1 : 10;
    const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
    const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
    const base = optimisticGeometry || { ...state.widget.position, ...state.widget.layout, height: window.innerHeight };
    geometry(resizing ? { width: base.width + dx, height: base.height + dy } : { x: base.x + dx, y: base.y + dy });
  });
  window.addEventListener('resize', measure);
  new ResizeObserver(measure).observe($('card'));
  api.onState(update);
  api.get().then(update).catch(() => error('Could not load this widget.'));
})();
