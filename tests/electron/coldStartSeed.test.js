'use strict';

// The cold-start seed is the widget's way of putting the previous run's
// numbers on screen before the first scan lands. Two things have to hold for
// that to be honest: main has to say the seed is from an earlier day, and the
// renderer has to show the age of the record it is displaying.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { MESSAGES } = require('../../src/electron/renderer/i18n');

const root = path.join(__dirname, '..', '..');
const main = fs.readFileSync(path.join(root, 'src/electron/main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src/electron/renderer/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src/electron/renderer/index.html'), 'utf8');

test('main marks a seed from another local day and keeps its capture time', () => {
  const prime = main.slice(
    main.indexOf('function primeLocalStatsFromAnchor('),
    main.indexOf('function startLocalCollector()')
  );
  // The anchor's own day decides it: a same-day seed needs no marker, because
  // its numbers are today's either way.
  assert.match(prime, /const seedDay = String\(saved\?\.dateKey \|\| ''\)/);
  assert.match(prime, /seedDay !== localTodayKey\(new Date\(\)\)/);
  // The capture time travels with the push, so the renderer can say how old
  // the numbers on screen are.
  assert.match(prime, /reason: 'anchor', stats: localStats, at: deviceRecord\.receivedAt, staleSeed/);
});

test('the renderer keeps the seed age and shows it under the total', () => {
  assert.match(renderer, /state\.coldStartSeed = payload\.data\?\.reason === 'anchor' && payload\.data\?\.staleSeed/);
  assert.match(renderer, /function renderColdStartSeedNote\(\)/);
  // The note goes under the number, where the reader already is, and it is
  // cleared as soon as a live push replaces the seed.
  assert.match(renderer, /renderColdStartSeedNote\(\);/);
  assert.match(html, /<div id="totalSeedNote" class="total-seed-note hidden"><\/div>/);
});

test('the cold-start note is localized in every bundled locale', () => {
  const locales = Object.entries(MESSAGES);
  assert.ok(locales.length >= 6, 'the bundled locales are checked');
  for (const [locale, messages] of locales) {
    const value = messages['views.coldStartSeed'];
    assert.equal(typeof value, 'string', `${locale} is missing views.coldStartSeed`);
    assert.ok(value.includes('{age}'), `${locale} does not interpolate the age`);
  }
});
