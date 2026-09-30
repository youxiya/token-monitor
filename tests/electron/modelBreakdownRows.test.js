'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MODEL_BREAKDOWN_MODES,
  DEFAULT_MODEL_BREAKDOWN_MODE,
  normalizeModelBreakdownMode,
  mixedModelRows,
  providerSummaryRows,
  rowsForMode
} = require('../../src/electron/renderer/modelBreakdownRows');

const period = {
  models: { 'deepseek-v4.1-flash': 180, 'glm-5.2': 100, 'no-route': 25 },
  modelCosts: { 'deepseek-v4.1-flash': 1.8, 'glm-5.2': 1, 'no-route': 0.25 },
  modelCacheReads: { 'deepseek-v4.1-flash': 30, 'glm-5.2': 5 },
  modelCacheWrites: { 'glm-5.2': 2 },
  modelOutputs: { 'deepseek-v4.1-flash': 30, 'glm-5.2': 10 },
  modelProviders: {
    'deepseek-v4.1-flash': {
      router: { tokens: 120, costUsd: 1.2, cacheReadTokens: 20, cacheWriteTokens: 0, outputTokens: 25 },
      kala: { tokens: 40, costUsd: 0.4, cacheReadTokens: 5, cacheWriteTokens: 0, outputTokens: 3 }
    },
    'glm-5.2': {
      codearts: { tokens: 100, costUsd: 1, cacheReadTokens: 5, cacheWriteTokens: 2, outputTokens: 10 }
    }
  }
};

test('normalizeModelBreakdownMode falls back to the default mode', () => {
  assert.equal(DEFAULT_MODEL_BREAKDOWN_MODE, 'mixed');
  assert.deepEqual([...MODEL_BREAKDOWN_MODES].sort(), ['mixed', 'model', 'provider']);
  for (const mode of MODEL_BREAKDOWN_MODES) {
    assert.equal(normalizeModelBreakdownMode(mode), mode);
  }
  for (const invalid of [undefined, null, '', 'merged', 7]) {
    assert.equal(normalizeModelBreakdownMode(invalid), 'mixed');
  }
});

test('mixed rows split a routed model per provider and keep unrouted models whole', () => {
  const rows = mixedModelRows(period);
  const byKey = new Map(rows.map((row) => [row.key, row]));

  assert.deepEqual(
    rows.filter((row) => row.model === 'deepseek-v4.1-flash').map((row) => [row.provider, row.value, row.cost]),
    [['router', 120, 1.2], ['kala', 40, 0.4], [null, 20, 0.2]]
  );
  // The remainder row is the unattributed tail of the merged model total.
  const remainder = byKey.get('deepseek-v4.1-flash');
  assert.equal(remainder.unattributed, true);
  assert.equal(remainder.provider, null);
  assert.equal(remainder.cacheReadTokens, 5);
  assert.equal(remainder.outputTokens, 2);
  assert.equal(remainder.name, 'deepseek-v4.1-flash');
  // A model whose every row carries one provider is not split in mixed mode?
  // It is: the route is the identity the user asked for.
  const codearts = byKey.get('codearts\u001Fglm-5.2');
  assert.equal(codearts.value, 100);
  assert.equal(codearts.provider, 'codearts');
  assert.equal(codearts.cacheWriteTokens, 2);
  // Models without any routing entries keep the historical row shape.
  const plain = byKey.get('no-route');
  assert.equal(plain.provider, null);
  assert.equal(plain.unattributed, false);
  assert.equal(plain.value, 25);
  assert.equal(plain.cost, 0.25);
  // Rows always sum back to the merged model totals.
  for (const model of Object.keys(period.models)) {
    const modelRows = rows.filter((row) => row.model === model);
    assert.equal(modelRows.reduce((sum, row) => sum + row.value, 0), period.models[model]);
  }
});

test('provider summary rows aggregate across models with one unattributed remainder', () => {
  const rows = providerSummaryRows(period, { unattributedLabel: 'Unclassified' });
  const byKey = new Map(rows.map((row) => [row.key, row]));

  assert.equal(byKey.get('provider\u001Frouter').value, 120);
  assert.equal(byKey.get('provider\u001Fkala').value, 40);
  assert.equal(byKey.get('provider\u001Fcodearts').value, 100);
  assert.equal(byKey.get('provider\u001Fcodearts').cost, 1);
  const remainder = byKey.get('__unattributed');
  assert.equal(remainder.unattributed, true);
  assert.equal(remainder.value, 45);
  assert.equal(remainder.name, 'Unclassified');
  assert.equal(
    rows.reduce((sum, row) => sum + row.value, 0),
    Object.values(period.models).reduce((sum, value) => sum + value, 0)
  );
});

test('a period without routing entries falls back to plain model rows', () => {
  const legacy = { models: { m: 5 }, modelCosts: { m: 0.1 } };
  assert.deepEqual(mixedModelRows(legacy).map(({ key, value, unattributed }) => [key, value, unattributed]), [['m', 5, false]]);
  // Provider mode cannot split unrouted usage, so it reports one unattributed
  // row carrying the whole total instead of dropping it.
  assert.deepEqual(providerSummaryRows(legacy).map(({ key, value, unattributed }) => [key, value, unattributed]), [['__unattributed', 5, true]]);
});

test('stale routing keys are ignored instead of surfacing as rows', () => {
  const stale = {
    models: { current: 10 },
    modelProviders: { reconciled: { router: { tokens: 9, costUsd: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } } }
  };
  // The live model keeps its plain row; only the orphaned routing key drops.
  assert.deepEqual(mixedModelRows(stale).map(({ key, value, unattributed }) => [key, value, unattributed]), [['current', 10, false]]);
  assert.deepEqual(providerSummaryRows(stale).map(({ key, value, unattributed }) => [key, value, unattributed]), [['__unattributed', 10, true]]);
});

test('rowsForMode dispatches by mode and falls back to the default for unknown modes', () => {
  assert.deepEqual(rowsForMode(period, 'mixed'), mixedModelRows(period));
  assert.deepEqual(rowsForMode(period, 'provider'), providerSummaryRows(period));
  assert.equal(rowsForMode(period, 'model'), null);
  // An unrecognized mode falls back to the default rather than dropping rows.
  assert.deepEqual(rowsForMode(period, 'nonsense'), mixedModelRows(period));
});
