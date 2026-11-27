import assert from 'node:assert/strict';
import test from 'node:test';
import { defaults, makePatch } from '../lib/compaction.mjs';

const basic = config => ({ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config });
const group = (...config) => ({ id: 'compaction', name: 'cordis:group', group: true, isolate: { compaction: true }, config });
const preset = (id, ...plugins) => ({ id: `preset-${id}`, name: '@deepseek-ai/dsh-agent-preset', config: { id, order: 1, plugins } });

test('updates enabled preset routes including exact model overrides, without touching other settings', () => {
  const disabledHost = { ...basic({}), disabled: true };
  const sibling = { id: 'tool-demo', name: 'demo', config: { enabled: true } };
  const base = [disabledHost, preset('standard', sibling, group(basic({ auto: true, retainRatio: 0.2, modelPolicies: [
    { provider: 'openai-codex', model: 'gpt-demo', headroomTokens: 512, summarizationProvider: 'old', summarizationModel: 'old' },
  ] }), sibling)), preset('other', group(basic({ auto: false })))];
  const before = structuredClone(base);
  const { patch, presets } = makePatch(base, defaults);
  assert.deepEqual(base, before);
  assert.deepEqual(presets, ['standard', 'other']);
  const config = patch[0].config;
  assert.equal(config.order, 1);
  assert.deepEqual(config.plugins[0], sibling);
  assert.deepEqual(config.plugins[1].config[1], sibling);
  const engine = config.plugins[1].config[0].config;
  assert.equal(engine.retainRatio, 0.2);
  assert.equal(engine.summarizationProvider, defaults.provider);
  assert.equal(engine.summarizationModel, defaults.model);
  assert.deepEqual(engine.modelPolicies, [{ provider: 'openai-codex', model: 'gpt-demo', headroomTokens: 512, summarizationProvider: defaults.provider, summarizationModel: defaults.model }]);
  assert.equal(patch[1].config.plugins[0].config[0].config.auto, false);
  assert.deepEqual(makePatch(base, defaults).patch, patch);
});

test('refuses a top-level engine or unsupported model policy format', () => {
  assert.throws(() => makePatch([basic({})], defaults), /preset-level/);
  assert.throws(() => makePatch([preset('standard', group(basic({ modelPolicies: {} })))], defaults), /modelPolicies/);
});
