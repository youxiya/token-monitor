#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const {
  REGISTRY_PATH,
  currentHubSourceBuildIds,
  readRegistry,
  updatedRegistry
} = require('./hub-build-manifest');

const previous = readRegistry();
const next = updatedRegistry(previous, currentHubSourceBuildIds());

if (JSON.stringify(previous) === JSON.stringify(next)) {
  console.log('Hub build registry is already current.');
  process.exit(0);
}

// `--check` reports a stale registry without touching the tree, so a packaging
// step can fail fast instead of shipping an outdated Hub build identity.
if (process.argv.includes('--check')) {
  console.error('Hub build registry is stale. Run `npm run update:hub-build` and commit the result.');
  process.exit(1);
}

fs.writeFileSync(REGISTRY_PATH, `${JSON.stringify(next, null, 2)}\n`);
console.log('Updated Hub build registry. Run npm run sync:worker to copy it into worker/.');
