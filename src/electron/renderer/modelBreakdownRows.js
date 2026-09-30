'use strict';

(function exposeModelBreakdownRows(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorModelBreakdownRows = api;
})(typeof window !== 'undefined' ? window : null, function createModelBreakdownRowsApi() {
  // Display modes for the model breakdown view, mirroring dsh-all-usage:
  // 'mixed' keeps one row per provider/model route, 'model' merges routes into
  // one row per served model (the historical shape), 'provider' summarizes by
  // routing provider across models.
  const MODEL_BREAKDOWN_MODES = ['mixed', 'model', 'provider'];
  const DEFAULT_MODEL_BREAKDOWN_MODE = 'mixed';
  // A provider-qualified key must never collide with a plain model key (the
  // remainder row reuses the model key), so the composite carries a separator
  // that model and provider names cannot contain.
  const PROVIDER_KEY_SEPARATOR = '\u001F';

  function normalizeModelBreakdownMode(value) {
    return MODEL_BREAKDOWN_MODES.includes(value) ? value : DEFAULT_MODEL_BREAKDOWN_MODE;
  }

  function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function emptyMetrics() {
    return { value: 0, cost: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  }

  function accumulateMetrics(target, source) {
    target.value += finiteNumber(source?.tokens);
    target.cost += finiteNumber(source?.costUsd);
    target.cacheReadTokens += finiteNumber(source?.cacheReadTokens);
    target.cacheWriteTokens += finiteNumber(source?.cacheWriteTokens);
    target.outputTokens += finiteNumber(source?.outputTokens);
  }

  function remainderMetrics(total, summed) {
    return {
      value: Math.max(0, finiteNumber(total?.value) - summed.value),
      cost: Math.max(0, Number((finiteNumber(total?.cost) - summed.cost).toFixed(6))),
      cacheReadTokens: Math.max(0, finiteNumber(total?.cacheReadTokens) - summed.cacheReadTokens),
      cacheWriteTokens: Math.max(0, finiteNumber(total?.cacheWriteTokens) - summed.cacheWriteTokens),
      outputTokens: Math.max(0, finiteNumber(total?.outputTokens) - summed.outputTokens)
    };
  }

  function hasMetrics(metrics) {
    return metrics.value > 0 || metrics.cost > 0 || metrics.cacheReadTokens > 0
      || metrics.cacheWriteTokens > 0 || metrics.outputTokens > 0;
  }

  function modelTotals(period, model) {
    return {
      value: finiteNumber(period?.models?.[model]),
      cost: finiteNumber(period?.modelCosts?.[model]),
      cacheReadTokens: finiteNumber(period?.modelCacheReads?.[model]),
      cacheWriteTokens: finiteNumber(period?.modelCacheWrites?.[model]),
      outputTokens: finiteNumber(period?.modelOutputs?.[model])
    };
  }

  function modelProviderEntries(period) {
    const map = period?.modelProviders;
    const result = [];
    if (!map || typeof map !== 'object') return result;
    for (const [model, providers] of Object.entries(map)) {
      // Entries without a matching `models` total describe a stale key (for
      // example a reconciled cursor-auto model) and must not surface as rows.
      if (!period?.models || !Object.hasOwn(period.models, model)) continue;
      if (!providers || typeof providers !== 'object') continue;
      for (const [provider, metrics] of Object.entries(providers)) {
        if (!metrics || typeof metrics !== 'object') continue;
        result.push({ model, provider, metrics });
      }
    }
    return result;
  }

  // One row per provider/model route. Models with no routing entries keep the
  // plain merged row; a model whose entries do not cover its totals grows an
  // unattributed remainder row (archived sessions and older producers route no
  // split), so mixed rows always sum back to the merged model totals.
  function mixedModelRows(period, _helpers = {}) {
    const rows = [];
    const entriesByModel = new Map();
    for (const entry of modelProviderEntries(period)) {
      if (!entriesByModel.has(entry.model)) entriesByModel.set(entry.model, []);
      entriesByModel.get(entry.model).push(entry);
    }
    const models = period?.models && typeof period.models === 'object' ? period.models : {};
    for (const model of Object.keys(models)) {
      const totals = modelTotals(period, model);
      const entries = entriesByModel.get(model) || [];
      if (entries.length === 0) {
        rows.push({
          key: model,
          name: model,
          model,
          provider: null,
          ...totals,
          unclassifiedTokens: finiteNumber(period?.modelUnclassifiedTokens?.[model]),
          unattributed: false
        });
        continue;
      }
      const summed = emptyMetrics();
      for (const entry of entries) {
        accumulateMetrics(summed, entry.metrics);
        rows.push({
          key: `${entry.provider}${PROVIDER_KEY_SEPARATOR}${model}`,
          name: `${entry.provider} / ${model}`,
          model,
          provider: entry.provider,
          value: finiteNumber(entry.metrics.tokens),
          cost: finiteNumber(entry.metrics.costUsd),
          cacheReadTokens: finiteNumber(entry.metrics.cacheReadTokens),
          cacheWriteTokens: finiteNumber(entry.metrics.cacheWriteTokens),
          outputTokens: finiteNumber(entry.metrics.outputTokens),
          unclassifiedTokens: 0,
          unattributed: false
        });
      }
      const remainder = remainderMetrics(totals, summed);
      if (hasMetrics(remainder)) {
        rows.push({
          key: model,
          name: model,
          model,
          provider: null,
          ...remainder,
          unclassifiedTokens: 0,
          unattributed: true
        });
      }
    }
    return rows;
  }

  // One row per routing provider, summed across models. Rows sum back to the
  // merged model totals with one unattributed remainder for usage that carries
  // no routing split.
  function providerSummaryRows(period, helpers = {}) {
    const byProvider = new Map();
    for (const entry of modelProviderEntries(period)) {
      if (!byProvider.has(entry.provider)) byProvider.set(entry.provider, emptyMetrics());
      accumulateMetrics(byProvider.get(entry.provider), entry.metrics);
    }
    const total = emptyMetrics();
    for (const model of Object.keys(period?.models || {})) {
      const modelTotal = modelTotals(period, model);
      total.value += modelTotal.value;
      total.cost += modelTotal.cost;
      total.cacheReadTokens += modelTotal.cacheReadTokens;
      total.cacheWriteTokens += modelTotal.cacheWriteTokens;
      total.outputTokens += modelTotal.outputTokens;
    }
    const rows = [...byProvider.entries()].map(([provider, metrics]) => ({
      key: `provider${PROVIDER_KEY_SEPARATOR}${provider}`,
      name: provider,
      model: null,
      provider,
      ...metrics,
      unclassifiedTokens: 0,
      unattributed: false
    }));
    const remainder = remainderMetrics(total, {
      value: rows.reduce((sum, row) => sum + row.value, 0),
      cost: rows.reduce((sum, row) => sum + row.cost, 0),
      cacheReadTokens: rows.reduce((sum, row) => sum + row.cacheReadTokens, 0),
      cacheWriteTokens: rows.reduce((sum, row) => sum + row.cacheWriteTokens, 0),
      outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0)
    });
    if (hasMetrics(remainder)) {
      rows.push({
        key: '__unattributed',
        name: typeof helpers.unattributedLabel === 'string' ? helpers.unattributedLabel : '',
        model: null,
        provider: null,
        ...remainder,
        unclassifiedTokens: 0,
        unattributed: true
      });
    }
    return rows;
  }

  function rowsForMode(period, mode, helpers = {}) {
    const effective = normalizeModelBreakdownMode(mode);
    if (effective === 'mixed') return mixedModelRows(period, helpers);
    if (effective === 'provider') return providerSummaryRows(period, helpers);
    return null;
  }

  return {
    MODEL_BREAKDOWN_MODES,
    DEFAULT_MODEL_BREAKDOWN_MODE,
    normalizeModelBreakdownMode,
    mixedModelRows,
    providerSummaryRows,
    rowsForMode
  };
});
