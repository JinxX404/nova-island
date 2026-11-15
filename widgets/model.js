(function attachWidgetModel(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.WidgetModel = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function buildWidgetModel(root) {
  'use strict';

  const KINDS = Object.freeze(['text', 'countdown', 'links', 'image', 'goal']);
  const PRESETS = Object.freeze(['note', 'statement', 'label']);
  const SIZE_PRESETS = Object.freeze({ compact: 220, medium: 320, wide: 480 });
  const MAX_WIDGETS = 32;
  const MAX_IMAGE_DATA_URL = 6 * 1024 * 1024;
  const MAX_SAFE_COORD = Number.MAX_SAFE_INTEGER;
  const FONT_WEIGHTS = Object.freeze([400, 500, 600, 700, 800]);
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

  let idSequence = 0;

  function isRecord(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function requireRecord(value, label) {
    if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
    return value;
  }

  function getOrDefault(record, key, fallback) {
    if (!own(record, key)) return fallback;
    return record[key];
  }

  function requireString(value, label, maxLength) {
    if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
    if (maxLength !== undefined && value.length > maxLength) {
      throw new RangeError(`${label} must be at most ${maxLength} characters`);
    }
    return value;
  }

  function enumValue(value, choices, label) {
    if (!choices.includes(value)) throw new TypeError(`${label} is invalid`);
    return value;
  }

  function finiteNumber(value, label) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`${label} must be a finite number`);
    }
    return value;
  }

  function numberField(record, key, fallback, min, max, options) {
    if (!own(record, key)) return fallback;
    let value = finiteNumber(record[key], key);
    value = Math.min(Math.max(value, min), max);
    if (options && options.integer) value = Math.round(value);
    if (options && options.allowed) {
      let nearest = options.allowed[0];
      let distance = Math.abs(value - nearest);
      for (let index = 1; index < options.allowed.length; index += 1) {
        const candidate = options.allowed[index];
        const candidateDistance = Math.abs(value - candidate);
        if (candidateDistance < distance) {
          nearest = candidate;
          distance = candidateDistance;
        }
      }
      value = nearest;
    }
    return value;
  }

  function booleanField(record, key, fallback) {
    if (!own(record, key)) return fallback;
    if (typeof record[key] !== 'boolean') throw new TypeError(`${key} must be a boolean`);
    return record[key];
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function safeId(value) {
    return typeof value === 'string' && value.length >= 1 && value.length <= 80 && /^[A-Za-z0-9_-]+$/.test(value);
  }

  function makeId() {
    idSequence += 1;
    let entropy = '';
    try {
      const cryptoApi = root && root.crypto;
      if (cryptoApi && typeof cryptoApi.getRandomValues === 'function' && typeof Uint32Array === 'function') {
        const words = new Uint32Array(4);
        cryptoApi.getRandomValues(words);
        entropy = Array.from(words, (word) => word.toString(36)).join('');
      }
    } catch (_) {
      // The per-module sequence and timestamp still distinguish factory calls when
      // secure browser randomness is unavailable.
    }
    return `widget-${Date.now().toString(36)}-${idSequence.toString(36)}${entropy ? `-${entropy}` : ''}`;
  }

  function readId(record, key) {
    if (!own(record, key)) return makeId();
    const value = requireString(record[key], key, 80);
    if (!safeId(value)) throw new TypeError(`${key} must be a safe non-empty identifier`);
    return value;
  }

  function dateTomorrowIso() {
    return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  }

  function isIsoDate(value) {
    if (typeof value !== 'string') return false;
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?)?$/);
    if (!match) return false;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const calendarDate = new Date(0);
    calendarDate.setUTCFullYear(year, month - 1, day);
    calendarDate.setUTCHours(0, 0, 0, 0);
    if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1 || calendarDate.getUTCDate() !== day) return false;

    if (match[4] !== undefined) {
      const hour = Number(match[4]);
      const minute = Number(match[5]);
      const second = match[6] === undefined ? 0 : Number(match[6]);
      if (hour > 23 || minute > 59 || second > 59) return false;
      if (match[8] !== undefined && match[8] !== 'Z') {
        const offsetHour = Number(match[8].slice(1, 3));
        const offsetMinute = Number(match[8].slice(4, 6));
        if (offsetHour > 23 || offsetMinute > 59) return false;
      }
    }
    return Number.isFinite(Date.parse(value));
  }

  function normalizedColor(value, label) {
    if (value === null) return null;
    if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) {
      throw new TypeError(`${label} must be null or a #RRGGBB color`);
    }
    return value;
  }

  function base64Value(character) {
    const code = character.charCodeAt(0);
    if (code >= 65 && code <= 90) return code - 65;
    if (code >= 97 && code <= 122) return code - 97 + 26;
    if (code >= 48 && code <= 57) return code - 48 + 52;
    if (character === '+') return 62;
    if (character === '/') return 63;
    return -1;
  }

  function decodeBase64Prefix(payload, wantedBytes) {
    const bytes = [];
    let accumulator = 0;
    let bits = 0;
    for (let index = 0; index < payload.length && bytes.length < wantedBytes; index += 1) {
      const value = base64Value(payload[index]);
      if (value < 0) break;
      accumulator = (accumulator << 6) | value;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((accumulator >> bits) & 0xff);
        accumulator &= (1 << bits) - 1;
      }
    }
    return bytes;
  }

  function hasImageSignature(mime, payload) {
    const bytes = decodeBase64Prefix(payload, 12);
    const is = (expected, offset) => expected.every((byte, index) => bytes[offset + index] === byte);
    if (mime === 'image/png') return is([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    if (mime === 'image/jpeg') return is([0xff, 0xd8, 0xff], 0);
    if (mime === 'image/gif') return is([0x47, 0x49, 0x46, 0x38], 0) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61;
    if (mime === 'image/webp') return is([0x52, 0x49, 0x46, 0x46], 0) && is([0x57, 0x45, 0x42, 0x50], 8);
    return false;
  }

  function validateImageDataUrl(value) {
    requireString(value, 'dataUrl');
    if (value === '') return value;
    if (value.length > MAX_IMAGE_DATA_URL) throw new RangeError('dataUrl exceeds 6 MiB');
    const match = value.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/i);
    if (!match) throw new TypeError('dataUrl must be a base64 PNG, JPEG, GIF, or WebP image');

    const mime = match[1].toLowerCase();
    const payload = match[2];
    if (payload.length === 0 || payload.length % 4 === 1) throw new TypeError('dataUrl has invalid base64 data');
    const firstPadding = payload.indexOf('=');
    const padding = firstPadding < 0 ? 0 : payload.length - firstPadding;
    if (padding > 0 && payload.length % 4 !== 0) throw new TypeError('dataUrl has invalid base64 padding');
    const dataLength = payload.length - padding;
    if ((padding === 1 && dataLength % 4 !== 3) || (padding === 2 && dataLength % 4 !== 2)) {
      throw new TypeError('dataUrl has invalid base64 padding');
    }
    const remainder = dataLength % 4;
    const tailValue = base64Value(payload[dataLength - 1]);
    if ((remainder === 2 && (tailValue & 15) !== 0) || (remainder === 3 && (tailValue & 3) !== 0)) {
      throw new TypeError('dataUrl has non-canonical base64 data');
    }
    if (!hasImageSignature(mime, payload)) throw new TypeError('dataUrl image signature does not match its MIME type');
    return value;
  }

  function validateWebsiteUrl(value) {
    requireString(value, 'target');
    if (!value || /[\u0000-\u0020\u007f\\]/.test(value) || !/^https?:\/\//i.test(value)) {
      throw new TypeError('website target must be an absolute HTTP or HTTPS URL');
    }
    let parsed;
    try {
      parsed = new URL(value);
    } catch (_) {
      throw new TypeError('website target is not a valid URL');
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname || parsed.username || parsed.password) {
      throw new TypeError('website target must be a safe HTTP or HTTPS URL');
    }
    return value;
  }

  function validateWindowsAppPath(value) {
    requireString(value, 'target');
    const pathWithoutDriveColon = value.replace(/^[A-Za-z]:/, '');
    if (!value || /[\u0000-\u001f<>:"|?*]/.test(pathWithoutDriveColon) || /[. ](?:[\\/]|$)/.test(value)) {
      throw new TypeError('app target must be an absolute Windows .exe or .lnk path');
    }
    const isDrivePath = /^[A-Za-z]:[\\/]/.test(value) && value.indexOf(':', 2) === -1;
    const isUncPath = /^\\\\/.test(value) && !/^\\\\[?.]\\/.test(value);
    if (!isDrivePath && !isUncPath) throw new TypeError('app target must be an absolute Windows .exe or .lnk path');

    const normalizedSeparators = value.replace(/\//g, '\\');
    const segments = normalizedSeparators.split('\\');
    if (isDrivePath) {
      if (segments.slice(1).some((segment) => segment === '')) throw new TypeError('app target contains an empty path segment');
    } else if (segments.length < 5 || segments[0] !== '' || segments[1] !== '' || segments.slice(2).some((segment) => segment === '')) {
      throw new TypeError('app target must include a server, share, and file');
    }

    const basename = segments[segments.length - 1];
    if (!/\.(?:exe|lnk)$/i.test(basename)) throw new TypeError('app target must end in .exe or .lnk');
    return value;
  }

  function normalizeTextContent(raw) {
    const content = requireRecord(raw, 'content');
    const preset = enumValue(getOrDefault(content, 'preset', 'note'), PRESETS, 'preset');
    const titleDefault = preset === 'label' ? '' : 'Note';
    const titleValue = requireString(getOrDefault(content, 'title', titleDefault), 'title', 200);
    return {
      title: titleValue,
      text: requireString(getOrDefault(content, 'text', ''), 'text', 20000),
      preset,
    };
  }

  function normalizeCountdownContent(raw) {
    const content = requireRecord(raw, 'content');
    const target = own(content, 'target') ? content.target : dateTomorrowIso();
    if (!isIsoDate(target)) throw new TypeError('target must be a valid ISO date string');
    return {
      title: requireString(getOrDefault(content, 'title', 'My event'), 'title', 200),
      target,
      format: enumValue(getOrDefault(content, 'format', 'detailed'), ['detailed', 'days', 'date'], 'format'),
    };
  }

  function normalizeLinkItem(raw, seenIds) {
    const item = requireRecord(raw, 'link item');
    const id = readId(item, 'id');
    if (seenIds.has(id)) throw new TypeError('link item ids must be unique');
    const label = requireString(getOrDefault(item, 'label', ''), 'label', 100);
    const icon = requireString(getOrDefault(item, 'icon', ''), 'icon');
    if (Array.from(icon).length > 8 || /[\u0000-\u001f\u007f<>]/.test(icon)) {
      throw new RangeError('icon must be plain text or emoji with at most 8 characters');
    }
    const type = enumValue(getOrDefault(item, 'type', 'website'), ['website', 'app'], 'type');
    if (!own(item, 'target')) throw new TypeError('link item target is required');
    const target = requireString(item.target, 'target', 2048);
    if (!target) throw new TypeError('link item target is required');
    if (type === 'website') validateWebsiteUrl(target);
    else validateWindowsAppPath(target);
    seenIds.add(id);
    return { id, label, icon, type, target };
  }

  function normalizeLinksContent(raw) {
    const content = requireRecord(raw, 'content');
    const itemsValue = getOrDefault(content, 'items', []);
    if (!Array.isArray(itemsValue)) throw new TypeError('items must be an array');
    if (itemsValue.length > 24) throw new RangeError('links supports at most 24 items');
    const seenIds = new Set();
    const items = Array.from(itemsValue, (item) => normalizeLinkItem(item, seenIds));
    return {
      title: requireString(getOrDefault(content, 'title', 'Quick links'), 'title', 200),
      arrangement: enumValue(getOrDefault(content, 'arrangement', 'list'), ['list', 'grid'], 'arrangement'),
      items,
    };
  }

  function normalizeImageContent(raw) {
    const content = requireRecord(raw, 'content');
    return {
      dataUrl: validateImageDataUrl(getOrDefault(content, 'dataUrl', '')),
      name: requireString(getOrDefault(content, 'name', ''), 'name', 260),
      caption: requireString(getOrDefault(content, 'caption', ''), 'caption', 500),
      fit: enumValue(getOrDefault(content, 'fit', 'cover'), ['cover', 'contain'], 'fit'),
      imageHeight: numberField(content, 'imageHeight', 180, 64, 480, { integer: true }),
    };
  }

  function normalizeGoalContent(raw) {
    const content = requireRecord(raw, 'content');
    let target = own(content, 'target') ? finiteNumber(content.target, 'target') : 100;
    if (target <= 0) throw new RangeError('target must be above zero');
    target = Math.min(target, 1e12);
    return {
      title: requireString(getOrDefault(content, 'title', 'My goal'), 'title', 200),
      current: numberField(content, 'current', 0, 0, 1e12),
      target,
      unit: requireString(getOrDefault(content, 'unit', ''), 'unit', 40),
      progress: enumValue(getOrDefault(content, 'progress', 'bar'), ['bar', 'ring'], 'progress'),
    };
  }

  function defaultContent(kind) {
    if (kind === 'text') return { title: 'Note', text: '', preset: 'note' };
    if (kind === 'countdown') return { title: 'My event', target: dateTomorrowIso(), format: 'detailed' };
    if (kind === 'links') return { title: 'Quick links', arrangement: 'list', items: [] };
    if (kind === 'image') return { dataUrl: '', name: '', caption: '', fit: 'cover', imageHeight: 180 };
    return { title: 'My goal', current: 0, target: 100, unit: '', progress: 'bar' };
  }

  function normalizeContent(kind, raw) {
    switch (kind) {
      case 'text': return normalizeTextContent(raw);
      case 'countdown': return normalizeCountdownContent(raw);
      case 'links': return normalizeLinksContent(raw);
      case 'image': return normalizeImageContent(raw);
      case 'goal': return normalizeGoalContent(raw);
      default: throw new TypeError('kind is invalid');
    }
  }

  function appearanceDefaults(preset) {
    const defaults = {
      fontSize: 18,
      fontWeight: 400,
      align: 'start',
      lineHeight: 1.5,
      textColor: null,
      backgroundColor: null,
      accentColor: null,
      opacity: 0.92,
      padding: 20,
      direction: 'auto',
    };
    if (preset === 'statement') Object.assign(defaults, { fontSize: 32, fontWeight: 600, align: 'center', padding: 28 });
    if (preset === 'label') Object.assign(defaults, { fontSize: 16, padding: 8 });
    return defaults;
  }

  function normalizeAppearance(raw, preset) {
    const appearance = requireRecord(raw, 'appearance');
    const defaults = appearanceDefaults(preset);
    return {
      fontSize: numberField(appearance, 'fontSize', defaults.fontSize, 12, 72),
      fontWeight: numberField(appearance, 'fontWeight', defaults.fontWeight, 400, 800, { allowed: FONT_WEIGHTS }),
      align: enumValue(getOrDefault(appearance, 'align', defaults.align), ['start', 'center', 'end'], 'align'),
      lineHeight: numberField(appearance, 'lineHeight', defaults.lineHeight, 1, 2.5),
      textColor: normalizedColor(getOrDefault(appearance, 'textColor', null), 'textColor'),
      backgroundColor: normalizedColor(getOrDefault(appearance, 'backgroundColor', null), 'backgroundColor'),
      accentColor: normalizedColor(getOrDefault(appearance, 'accentColor', null), 'accentColor'),
      opacity: numberField(appearance, 'opacity', 0.92, 0.2, 1),
      padding: numberField(appearance, 'padding', defaults.padding, 4, 48, { integer: true }),
      direction: enumValue(getOrDefault(appearance, 'direction', 'auto'), ['auto', 'ltr', 'rtl'], 'direction'),
    };
  }

  function normalizeLayout(raw, preset) {
    const layout = requireRecord(raw, 'layout');
    return {
      width: numberField(layout, 'width', preset === 'label' ? 220 : 320, 180, 720, { integer: true }),
      height: numberField(layout, 'height', 180, 64, 800, { integer: true }),
      autoHeight: booleanField(layout, 'autoHeight', true),
    };
  }

  function normalizePosition(raw) {
    const position = requireRecord(raw, 'position');
    const normalizeCoordinate = (key, fallback) => {
      const value = own(position, key) ? finiteNumber(position[key], key) : fallback;
      const rounded = Math.round(clamp(value, -MAX_SAFE_COORD, MAX_SAFE_COORD));
      return rounded === 0 ? 0 : rounded;
    };
    return { x: normalizeCoordinate('x', 24), y: normalizeCoordinate('y', 100) };
  }

  function normalizeWidget(raw) {
    requireRecord(raw, 'widget');
    const kind = own(raw, 'kind') ? enumValue(raw.kind, KINDS, 'kind') : 'text';
    const contentInput = own(raw, 'content') ? raw.content : defaultContent(kind);
    const content = normalizeContent(kind, contentInput);
    const preset = kind === 'text' ? content.preset : 'note';
    const appearance = normalizeAppearance(own(raw, 'appearance') ? raw.appearance : {}, preset);
    const layout = normalizeLayout(own(raw, 'layout') ? raw.layout : {}, preset);
    const position = normalizePosition(own(raw, 'position') ? raw.position : {});
    return {
      id: readId(raw, 'id'),
      kind,
      content,
      appearance,
      layout,
      position,
      hidden: booleanField(raw, 'hidden', false),
      locked: booleanField(raw, 'locked', false),
    };
  }

  function createWidget(kind, preset, id) {
    if (kind === undefined) kind = 'text';
    if (preset === undefined) preset = 'note';
    enumValue(kind, KINDS, 'kind');
    enumValue(preset, PRESETS, 'preset');
    const content = defaultContent(kind);
    if (kind === 'text') {
      content.preset = preset;
      if (preset === 'label') content.title = '';
    }
    const appearance = appearanceDefaults(kind === 'text' ? preset : 'note');
    const layout = { width: kind === 'text' && preset === 'label' ? 220 : 320, height: 180, autoHeight: true };
    const raw = {
      id: id === undefined ? makeId() : id,
      kind,
      content,
      appearance,
      layout,
      position: { x: 24, y: 100 },
      hidden: false,
      locked: false,
    };
    return normalizeWidget(raw);
  }

  function normalizeStore(raw) {
    requireRecord(raw, 'store');
    const version = own(raw, 'version') ? raw.version : 1;
    if (version !== 1) throw new RangeError('unsupported widget store version');
    const records = own(raw, 'widgets') ? raw.widgets : [];
    if (!Array.isArray(records)) throw new TypeError('widgets must be an array');

    const widgets = [];
    const ids = new Set();
    for (const record of records) {
      let widget;
      try {
        widget = normalizeWidget(record);
      } catch (_) {
        continue;
      }
      if (ids.has(widget.id)) continue;
      if (widgets.length >= MAX_WIDGETS) throw new RangeError(`widget store supports at most ${MAX_WIDGETS} widgets`);
      ids.add(widget.id);
      widgets.push(widget);
    }
    return { version: 1, widgets };
  }

  function clampBounds(bounds, workArea) {
    requireRecord(bounds, 'bounds');
    requireRecord(workArea, 'workArea');
    const requiredNumber = (record, key, label) => {
      if (!own(record, key)) throw new TypeError(`${label}.${key} is required`);
      return finiteNumber(record[key], `${label}.${key}`);
    };

    const areaXValue = requiredNumber(workArea, 'x', 'workArea');
    const areaYValue = requiredNumber(workArea, 'y', 'workArea');
    const areaWidthValue = requiredNumber(workArea, 'width', 'workArea');
    const areaHeightValue = requiredNumber(workArea, 'height', 'workArea');
    if (areaWidthValue <= 0 || areaHeightValue <= 0) throw new RangeError('workArea width and height must be positive');

    const roundedAreaX = Math.round(clamp(areaXValue, -MAX_SAFE_COORD, MAX_SAFE_COORD));
    const roundedAreaY = Math.round(clamp(areaYValue, -MAX_SAFE_COORD, MAX_SAFE_COORD));
    const areaX = roundedAreaX === 0 ? 0 : roundedAreaX;
    const areaY = roundedAreaY === 0 ? 0 : roundedAreaY;
    const areaWidth = Math.max(1, Math.round(clamp(areaWidthValue, 1, MAX_SAFE_COORD)));
    const areaHeight = Math.max(1, Math.round(clamp(areaHeightValue, 1, MAX_SAFE_COORD)));
    const areaRight = areaX + areaWidth;
    const areaBottom = areaY + areaHeight;
    if (!Number.isSafeInteger(areaRight) || !Number.isSafeInteger(areaBottom)) {
      throw new RangeError('workArea edges exceed safe screen coordinates');
    }

    const widthValue = requiredNumber(bounds, 'width', 'bounds');
    const heightValue = requiredNumber(bounds, 'height', 'bounds');
    const width = Math.max(1, Math.min(areaWidth, Math.round(clamp(widthValue, 1, MAX_SAFE_COORD))));
    const height = Math.max(1, Math.min(areaHeight, Math.round(clamp(heightValue, 1, MAX_SAFE_COORD))));
    const xValue = requiredNumber(bounds, 'x', 'bounds');
    const yValue = requiredNumber(bounds, 'y', 'bounds');
    const roundedX = Math.round(clamp(Math.round(clamp(xValue, -MAX_SAFE_COORD, MAX_SAFE_COORD)), areaX, areaRight - width));
    const roundedY = Math.round(clamp(Math.round(clamp(yValue, -MAX_SAFE_COORD, MAX_SAFE_COORD)), areaY, areaBottom - height));
    const x = roundedX === 0 ? 0 : roundedX;
    const y = roundedY === 0 ? 0 : roundedY;
    return { x, y, width, height };
  }

  return Object.freeze({ KINDS, PRESETS, SIZE_PRESETS, MAX_WIDGETS, createWidget, normalizeWidget, normalizeStore, clampBounds });
});
