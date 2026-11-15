'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Model = require('../../widgets/model');
const { prepareContent } = require('../../widgets/inline-editor');

test('inline drafts normalize all five kinds without changing saved instances', () => {
  for (const kind of Model.KINDS) {
    const widget = Model.createWidget(kind);
    const original = JSON.stringify(widget);
    const draft = structuredClone(widget.content);
    if (kind === 'text') draft.text = 'العربية English\n**Plan**';
    else if (kind === 'goal') draft.current = 25;
    else if (kind === 'countdown') draft.target = '2030-01-01T12:00:00.000Z';
    else if (kind === 'image') draft.caption = 'Caption';
    else draft.items.push({ id: 'docs', label: 'Docs', icon: '↗', type: 'website', target: 'https://example.com/docs' });
    const content = prepareContent(widget, draft);
    assert.deepEqual(content, draft);
    assert.equal(JSON.stringify(widget), original, 'draft editing never changes saved content');
    assert.notEqual(content, draft);
  }
});
test('inline goal rejects missing, negative and non-finite amounts and nonpositive targets', () => {
  const widget = Model.createWidget('goal');
  for (const current of [null, NaN, Infinity, -1]) assert.throws(() => prepareContent(widget, { ...widget.content, current }), /Current amount/);
  for (const target of [null, NaN, Infinity, 0, -2]) assert.throws(() => prepareContent(widget, { ...widget.content, target }), /target above zero/);
  assert.equal(prepareContent(widget, { ...widget.content, current: 1.5, target: 3 }).current, 1.5);
});
test('inline content rejects invalid dates and unsafe link targets', () => {
  const countdown = Model.createWidget('countdown');
  assert.throws(() => prepareContent(countdown, { ...countdown.content, target: '' }), /valid target date/);
  const widget = Model.createWidget('links');
  for (const target of ['javascript:alert(1)', 'https://user:pass@example.com', 'file:///C:/Windows']) {
    assert.throws(() => prepareContent(widget, { ...widget.content, items: [{ id: 'bad', label: 'Bad', icon: '', type: 'website', target }] }));
  }
});
