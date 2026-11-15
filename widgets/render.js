(function attachWidgetView(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.WidgetView = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function buildWidgetView() {
  'use strict';

  const KINDS = Object.freeze(['text', 'countdown', 'links', 'image', 'goal']);
  const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/i;
  const COLOR = /^#[0-9a-f]{6}$/i;

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function stringValue(value) {
    return typeof value === 'string' ? value : '';
  }

  function finiteOr(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function safeColor(value) {
    return typeof value === 'string' && COLOR.test(value) ? value : null;
  }

  function safeDirection(value) {
    return value === 'ltr' || value === 'rtl' ? value : 'auto';
  }

  function makeElement(document, tagName, className, text) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function appendText(document, parent, text) {
    if (text !== '') parent.appendChild(document.createTextNode(text));
  }

  function clearChildren(element) {
    if (typeof element.replaceChildren === 'function') {
      element.replaceChildren();
      return;
    }
    while (element.firstChild) element.removeChild(element.firstChild);
  }

  function setAttribute(element, name, value) {
    element.setAttribute(name, String(value));
  }

  function applyAppearance(card, widget) {
    if (!card || !card.style || typeof card.style.setProperty !== 'function') return card;

    const appearance = isRecord(widget && widget.appearance) ? widget.appearance : {};
    const fontSize = clamp(finiteOr(appearance.fontSize, 18), 12, 72);
    const fontWeight = [400, 500, 600, 700, 800].includes(appearance.fontWeight) ? appearance.fontWeight : 400;
    const align = ['start', 'center', 'end'].includes(appearance.align) ? appearance.align : 'start';
    const lineHeight = clamp(finiteOr(appearance.lineHeight, 1.5), 1, 2.5);
    const padding = clamp(finiteOr(appearance.padding, 20), 4, 48);
    const opacity = clamp(finiteOr(appearance.opacity, 0.92), 0.2, 1);
    const textColor = safeColor(appearance.textColor) || 'var(--th-text, #f7f7fb)';
    const backgroundColor = safeColor(appearance.backgroundColor)
      || 'var(--widget-theme-background, var(--th-bg, var(--th-tint, rgba(24, 26, 34, 0.92))))';
    const accentColor = safeColor(appearance.accentColor) || 'var(--th-hi, #8cc8ff)';
    const justify = align === 'center' ? 'center' : align === 'end' ? 'flex-end' : 'flex-start';

    card.style.setProperty('--widget-font-size', `${fontSize}px`);
    card.style.setProperty('--widget-font-weight', String(fontWeight));
    card.style.setProperty('--widget-align', align);
    card.style.setProperty('--widget-content-justify', justify);
    card.style.setProperty('--widget-line-height', String(lineHeight));
    card.style.setProperty('--widget-padding', `${padding}px`);
    card.style.setProperty('--widget-text-color', textColor);
    card.style.setProperty('--widget-background', backgroundColor);
    card.style.setProperty('--widget-accent-color', accentColor);
    card.style.setProperty('--widget-opacity', String(opacity));
    card.setAttribute('dir', safeDirection(appearance.direction));
    return card;
  }

  function setRootLabel(card, title, fallback) {
    const label = stringValue(title).trim() || fallback;
    setAttribute(card, 'role', 'article');
    setAttribute(card, 'aria-label', label);
  }

  function addHeader(document, card, title) {
    const value = stringValue(title);
    if (!value.trim()) return null;
    const heading = makeElement(document, 'h2', 'widget-title', value);
    setAttribute(heading, 'dir', 'auto');
    card.appendChild(heading);
    return heading;
  }

  function appendInline(document, parent, value) {
    const text = stringValue(value);
    const tokens = /(\*\*[^*\r\n]+?\*\*|\*[^*\r\n]+?\*)/g;
    let lastIndex = 0;
    let match;
    while ((match = tokens.exec(text)) !== null) {
      appendText(document, parent, text.slice(lastIndex, match.index));
      const bold = match[0].startsWith('**');
      const markerLength = bold ? 2 : 1;
      const tagName = bold ? 'strong' : 'em';
      parent.appendChild(makeElement(document, tagName, '', match[0].slice(markerLength, -markerLength)));
      lastIndex = match.index + match[0].length;
    }
    appendText(document, parent, text.slice(lastIndex));
  }

  function parseListLine(line) {
    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    if (unordered) return { type: 'unordered', text: unordered[1] };
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ordered) return { type: 'ordered', text: ordered[1] };
    return null;
  }

  function addTextBody(document, card, textValue) {
    const body = makeElement(document, 'div', 'widget-text-body');
    const lines = stringValue(textValue).split(/\r\n|\n|\r/);
    let paragraph = [];
    let list = null;

    function flushParagraph() {
      if (paragraph.length === 0) return;
      const element = makeElement(document, 'p', 'widget-paragraph');
      setAttribute(element, 'dir', 'auto');
      paragraph.forEach((line, index) => {
        if (index > 0) element.appendChild(makeElement(document, 'br', 'widget-line-break'));
        appendInline(document, element, line);
      });
      body.appendChild(element);
      paragraph = [];
    }

    function flushList() {
      if (list) body.appendChild(list.element);
      list = null;
    }

    for (const line of lines) {
      if (!line.trim()) {
        flushParagraph();
        flushList();
        continue;
      }

      const parsedList = parseListLine(line);
      if (!parsedList) {
        flushList();
        paragraph.push(line);
        continue;
      }

      flushParagraph();
      if (!list || list.type !== parsedList.type) {
        flushList();
        list = {
          type: parsedList.type,
          element: makeElement(document, parsedList.type === 'ordered' ? 'ol' : 'ul', 'widget-list'),
        };
      }
      const item = makeElement(document, 'li', 'widget-list-item');
      setAttribute(item, 'dir', 'auto');
      appendInline(document, item, parsedList.text);
      list.element.appendChild(item);
    }

    flushParagraph();
    flushList();
    card.appendChild(body);
    return body;
  }

  function formatNumber(value, maximumFractionDigits) {
    try {
      return new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(value);
    } catch (_) {
      return String(value);
    }
  }

  function formatMeasure(value) {
    if (value > 0 && value < 0.000001) return value.toExponential(2);
    return formatNumber(value, 6);
  }

  function renderText(document, card, widget) {
    const content = isRecord(widget.content) ? widget.content : {};
    const title = stringValue(content.title);
    setRootLabel(card, title, 'Text widget');
    addHeader(document, card, title);
    addTextBody(document, card, content.text);
  }

  function renderCountdown(document, card, widget, options) {
    const content = isRecord(widget.content) ? widget.content : {};
    const title = stringValue(content.title);
    setRootLabel(card, title, 'Countdown');
    addHeader(document, card, title);

    const targetValue = stringValue(content.target);
    const targetTime = Date.parse(targetValue);
    const now = finiteOr(options.now, Date.now());
    if (!Number.isFinite(targetTime)) {
      const unavailable = makeElement(document, 'p', 'widget-countdown-unavailable', 'Event date unavailable.');
      setAttribute(unavailable, 'dir', 'auto');
      card.appendChild(unavailable);
      return;
    }
    if (targetTime <= now) {
      const arrived = makeElement(document, 'p', 'widget-countdown-arrived', 'Event has arrived.');
      setAttribute(arrived, 'role', 'status');
      setAttribute(arrived, 'dir', 'auto');
      card.appendChild(arrived);
      return;
    }

    const time = makeElement(document, 'time', 'widget-countdown-value');
    setAttribute(time, 'datetime', targetValue);
    setAttribute(time, 'role', 'timer');
    setAttribute(time, 'aria-live', 'off');
    setAttribute(time, 'dir', 'auto');
    const format = ['detailed', 'days', 'date'].includes(content.format) ? content.format : 'detailed';
    const remaining = targetTime - now;

    if (format === 'date') {
      let dateText = targetValue;
      try {
        dateText = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(targetTime));
      } catch (_) {
        // ISO text remains a useful accessible fallback in older runtimes.
      }
      time.textContent = dateText;
    } else if (format === 'days') {
      const days = Math.ceil(remaining / 86400000);
      const dayText = days === 1 ? 'day' : 'days';
      time.textContent = `${formatNumber(days, 0)} ${dayText} remaining`;
      setAttribute(time, 'aria-label', `${days} ${dayText} remaining until ${title || 'event'}`);
    } else {
      let secondsLeft = Math.floor(remaining / 1000);
      const days = Math.floor(secondsLeft / 86400);
      secondsLeft %= 86400;
      const hours = Math.floor(secondsLeft / 3600);
      secondsLeft %= 3600;
      const minutes = Math.floor(secondsLeft / 60);
      const seconds = secondsLeft % 60;
      const parts = [];
      if (days > 0) parts.push(`${formatNumber(days, 0)} ${days === 1 ? 'day' : 'days'}`);
      if (days > 0 || hours > 0) parts.push(`${formatNumber(hours, 0)} ${hours === 1 ? 'hour' : 'hours'}`);
      if (days > 0 || hours > 0 || minutes > 0) parts.push(`${formatNumber(minutes, 0)} ${minutes === 1 ? 'minute' : 'minutes'}`);
      parts.push(`${formatNumber(seconds, 0)} ${seconds === 1 ? 'second' : 'seconds'}`);
      time.textContent = parts.join(' · ');
      setAttribute(time, 'aria-label', `${parts.join(', ')} until ${title || 'event'}`);
    }

    card.appendChild(time);
  }

  function renderLinks(document, card, widget, options) {
    const content = isRecord(widget.content) ? widget.content : {};
    const title = stringValue(content.title);
    setRootLabel(card, title, 'Quick links');
    addHeader(document, card, title);

    const items = Array.isArray(content.items) ? content.items : [];
    const arrangement = content.arrangement === 'grid' ? 'grid' : 'list';
    const wrapper = makeElement(document, 'div', `widget-links widget-links--${arrangement}`);
    if (items.length === 0) {
      const empty = makeElement(document, 'p', 'widget-empty', 'No links yet.');
      setAttribute(empty, 'dir', 'auto');
      wrapper.appendChild(empty);
    } else {
      const list = makeElement(document, 'ul', 'widget-link-list');
      items.forEach((itemValue, index) => {
        const item = isRecord(itemValue) ? itemValue : {};
        const label = stringValue(item.label).trim() || `Link ${index + 1}`;
        const row = makeElement(document, 'li', 'widget-link-row');
        const button = makeElement(document, 'button', 'widget-link-button');
        button.type = 'button';
        setAttribute(button, 'dir', 'auto');
        setAttribute(button, 'aria-label', label);
        if (typeof options.onLink === 'function') {
          button.addEventListener('click', () => options.onLink(index));
        } else {
          button.disabled = true;
        }

        const icon = stringValue(item.icon);
        if (icon) {
          const iconElement = makeElement(document, 'span', 'widget-link-icon', icon);
          setAttribute(iconElement, 'aria-hidden', 'true');
          button.appendChild(iconElement);
        }
        const labelElement = makeElement(document, 'span', 'widget-link-label', label);
        setAttribute(labelElement, 'dir', 'auto');
        button.appendChild(labelElement);
        row.appendChild(button);
        list.appendChild(row);
      });
      wrapper.appendChild(list);
    }
    card.appendChild(wrapper);
  }

  function setImageHeight(image, value) {
    const height = clamp(finiteOr(value, 180), 64, 480);
    if (image.style && typeof image.style.setProperty === 'function') image.style.setProperty('--widget-image-height', `${height}px`);
    else image.height = height;
  }

  function renderImage(document, card, widget) {
    const content = isRecord(widget.content) ? widget.content : {};
    const caption = stringValue(content.caption);
    const name = stringValue(content.name);
    setRootLabel(card, caption || name, 'Image widget');
    const figure = makeElement(document, 'figure', 'widget-image');
    const source = stringValue(content.dataUrl);
    const safeSource = source.length <= 6 * 1024 * 1024 && IMAGE_DATA_URL.test(source);

    function addFallback(message) {
      const fallback = makeElement(document, 'div', 'widget-image-fallback', message);
      setAttribute(fallback, 'role', 'status');
      setAttribute(fallback, 'dir', 'auto');
      figure.appendChild(fallback);
      return fallback;
    }

    if (safeSource) {
      const image = makeElement(document, 'img', 'widget-image-content');
      image.alt = caption || name || 'Widget image';
      image.decoding = 'async';
      image.loading = 'eager';
      image.style.objectFit = content.fit === 'contain' ? 'contain' : 'cover';
      setImageHeight(image, content.imageHeight);
      const fallback = addFallback(name || 'Image could not be loaded.');
      fallback.hidden = true;
      image.addEventListener('error', () => {
        image.hidden = true;
        fallback.hidden = false;
      });
      figure.insertBefore(image, fallback);
      image.src = source;
    } else {
      addFallback(name || 'No image selected.');
    }

    if (caption.trim()) {
      const captionElement = makeElement(document, 'figcaption', 'widget-image-caption', caption);
      setAttribute(captionElement, 'dir', 'auto');
      figure.appendChild(captionElement);
    }
    card.appendChild(figure);
  }

  function progressPercent(current, target) {
    const safeCurrent = Math.max(0, finiteOr(current, 0));
    const safeTarget = Math.max(Number.MIN_VALUE, finiteOr(target, 100));
    const raw = (safeCurrent / safeTarget) * 100;
    return clamp(Number.isFinite(raw) ? raw : 100, 0, 100);
  }

  function setProgressSemantics(element, percent, label) {
    setAttribute(element, 'role', 'progressbar');
    setAttribute(element, 'aria-label', label);
    setAttribute(element, 'aria-valuemin', 0);
    setAttribute(element, 'aria-valuemax', 100);
    setAttribute(element, 'aria-valuenow', Number(percent.toFixed(2)));
    setAttribute(element, 'aria-valuetext', `${Number(percent.toFixed(1))}% complete`);
  }

  function renderGoal(document, card, widget) {
    const content = isRecord(widget.content) ? widget.content : {};
    const title = stringValue(content.title);
    const current = Math.max(0, finiteOr(content.current, 0));
    const target = Math.max(Number.MIN_VALUE, finiteOr(content.target, 100));
    const unit = stringValue(content.unit);
    const percent = progressPercent(current, target);
    const roundedPercent = Number(percent.toFixed(2));
    const percentLabel = `${Number(percent.toFixed(1))}%`;
    setRootLabel(card, title, 'Goal');
    addHeader(document, card, title);

    const goal = makeElement(document, 'div', 'widget-goal');
    const label = title || 'Goal progress';
    if (content.progress === 'ring') {
      const ring = makeElement(document, 'div', 'widget-goal-ring');
      ring.style.setProperty('--widget-progress', `${roundedPercent}%`);
      setProgressSemantics(ring, percent, label);
      const hole = makeElement(document, 'div', 'widget-goal-ring-hole');
      hole.appendChild(makeElement(document, 'span', 'widget-goal-percent', percentLabel));
      ring.appendChild(hole);
      goal.appendChild(ring);
    } else {
      const track = makeElement(document, 'div', 'widget-goal-bar');
      track.style.setProperty('--widget-progress', `${roundedPercent}%`);
      setProgressSemantics(track, percent, label);
      track.appendChild(makeElement(document, 'span', 'widget-goal-bar-fill'));
      goal.appendChild(track);
    }

    const formattedCurrent = formatMeasure(current);
    const formattedTarget = formatMeasure(target);
    const suffix = unit ? ` ${unit}` : '';
    const summary = makeElement(document, 'p', 'widget-goal-summary', `${formattedCurrent} / ${formattedTarget}${suffix}`);
    setAttribute(summary, 'dir', 'auto');
    goal.appendChild(summary);
    card.appendChild(goal);
  }

  function render(container, widget, options) {
    if (!container || typeof container.appendChild !== 'function') throw new TypeError('container must be a DOM element');
    const document = container.ownerDocument || (typeof globalThis !== 'undefined' ? globalThis.document : null);
    if (!document || typeof document.createElement !== 'function') throw new TypeError('container must belong to a document');
    const value = isRecord(widget) ? widget : {};
    const settings = isRecord(options) ? options : {};
    const kind = KINDS.includes(value.kind) ? value.kind : 'text';

    clearChildren(container);
    if (container.classList && typeof container.classList.add === 'function') container.classList.add('widget-card');
    else if (typeof container.className === 'string' && !/(^|\s)widget-card(?:\s|$)/.test(container.className)) container.className = `${container.className} widget-card`.trim();
    applyAppearance(container, value);

    if (kind === 'countdown') renderCountdown(document, container, value, settings);
    else if (kind === 'links') renderLinks(document, container, value, settings);
    else if (kind === 'image') renderImage(document, container, value);
    else if (kind === 'goal') renderGoal(document, container, value);
    else renderText(document, container, value);
    return container;
  }

  return Object.freeze({ render, applyAppearance });
});
