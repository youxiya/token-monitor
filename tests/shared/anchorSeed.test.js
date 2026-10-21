'use strict';

// UTC+8 with no DST. The timezone matters: the whole point of the periodWindows
// assertion below is a local day that has not rolled over in UTC yet, which only
// exists ahead of UTC.
process.env.TZ = 'Asia/Shanghai';

const assert = require('node:assert/strict');
const test = require('node:test');

const { deviceRecordFromAnchor } = require('../../src/shared/anchorSeed');
const { configFingerprint } = require('../../src/shared/collector');
const { qoderCnDataPaths } = require('../../src/shared/providers/qodercn/paths');
const { aggregateDevices, emptyPeriod } = require('../../src/shared/usage');

const CLIENTS = 'claude,codex';
const ALL_TIME_SINCE = '2024-01-01';

function periodWith(totalTokens) {
  const period = emptyPeriod();
  period.totalTokens = totalTokens;
  return period;
}

// Local 2026-08-08 02:00 (UTC 2026-08-07T18:00), so the anchor lands on a local
// day whose UTC day is still the one before.
const FULL_SCAN_AT = '2026-08-07T18:00:00.000Z';
const NOW = new Date(2026, 7, 8, 10, 0, 0); // local 2026-08-08 10:00, UTC 02:00

function anchorFixture(overrides = {}) {
  return {
    dateKey: '2026-08-08',
    today: periodWith(1_000),
    month: periodWith(30_000),
    allTime: periodWith(900_000),
    configFingerprint: configFingerprint(CLIENTS, ALL_TIME_SINCE, true),
    fullScanAt: FULL_SCAN_AT,
    ...overrides
  };
}

function seedOptions(overrides = {}) {
  return {
    envelope: { deviceId: 'device-a', agentVersion: '9.9.9', agentRuntime: 'electron-widget' },
    clients: CLIENTS,
    allTimeSince: ALL_TIME_SINCE,
    projectsEnabled: true,
    wslScanEnabled: true,
    hostname: 'host-a',
    platform: 'darwin-arm64',
    now: NOW,
    ...overrides
  };
}

test('a matching anchor seeds a full device record', () => {
  const record = deviceRecordFromAnchor(anchorFixture(), seedOptions());

  assert.equal(record.deviceId, 'device-a');
  // Straight from the envelope. A record without them reaches the renderer as an
  // unidentified device, which is worse than the zeros this path replaces.
  assert.equal(record.agentVersion, '9.9.9');
  assert.equal(record.agentRuntime, 'electron-widget');
  assert.equal(record.hostname, 'host-a');
  assert.deepEqual(record.trackedClients, ['claude', 'codex']);
  assert.equal(record.updatedAt, FULL_SCAN_AT);
  assert.equal(record.today.totalTokens, 1_000);
  assert.equal(record.month.totalTokens, 30_000);
  assert.equal(record.allTime.totalTokens, 900_000);
  // Drives whether the all-time project breakdown is flagged incomplete, so a
  // seed without it renders differently from the record that replaces it.
  assert.equal(record.projectsEnabled, true);
  // Not a Windows host, so no WSL status at all rather than an empty one.
  assert.equal(Object.prototype.hasOwnProperty.call(record, 'wslStatus'), false);
});

test('WSL status follows the platform and the toggle, the way a collected record does', () => {
  const wslStatus = { state: 'active', detected: ['claude'], withData: ['claude'] };

  const restored = deviceRecordFromAnchor(
    anchorFixture({ wslStatus }),
    seedOptions({ wslSupported: true, platform: 'win32-x64' })
  );
  assert.deepEqual(restored.wslStatus, wslStatus);

  // Disabled is a state the panel renders, not the same as not knowing yet.
  const off = deviceRecordFromAnchor(
    anchorFixture({ wslStatus }),
    seedOptions({ wslSupported: true, wslScanEnabled: false, platform: 'win32-x64' })
  );
  assert.deepEqual(off.wslStatus, { state: 'disabled', detected: [], withData: [] });

  const noSnapshot = deviceRecordFromAnchor(
    anchorFixture(),
    seedOptions({ wslSupported: true, platform: 'win32-x64' })
  );
  assert.equal(Object.prototype.hasOwnProperty.call(noSnapshot, 'wslStatus'), false);
});

test('the seed reports the project setting it was built under', () => {
  const off = deviceRecordFromAnchor(
    anchorFixture({ configFingerprint: configFingerprint(CLIENTS, ALL_TIME_SINCE, false) }),
    seedOptions({ projectsEnabled: false })
  );
  assert.equal(off.projectsEnabled, false);
});

test('the cold-start seed accepts an anchor configured for Qoder CN', () => {
  const homeDir = '/tmp/token-monitor-qodercn-home';
  const cnPaths = qoderCnDataPaths({ homeDir });
  const clients = 'claude,qodercn';
  const anchor = anchorFixture({
    configFingerprint: configFingerprint(clients, ALL_TIME_SINCE, true, cnPaths.dbPaths[0], cnPaths.projectsDir)
  });

  const record = deviceRecordFromAnchor(anchor, seedOptions({ clients, homeDir }));
  assert.equal(record.today.totalTokens, 1_000);
  assert.deepEqual(record.trackedClients, ['claude', 'qodercn']);
});

test('the seed refuses a Qoder CN anchor that predates the JSONL source', () => {
  // A DB-only fingerprint cannot cover transcript usage: reusing it would show
  // month/allTime from before the storage migration while only today's JSONL
  // is scanned. The projects dir must be part of the trusted fingerprint.
  const homeDir = '/tmp/token-monitor-qodercn-home';
  const cnPaths = qoderCnDataPaths({ homeDir });
  const clients = 'claude,qodercn';
  const legacyAnchor = anchorFixture({
    configFingerprint: configFingerprint(clients, ALL_TIME_SINCE, true, cnPaths.dbPaths[0])
  });
  assert.equal(deviceRecordFromAnchor(legacyAnchor, seedOptions({ clients, homeDir })), null);
});

test('the seed carries local-only native Reasonix views when the anchor has them', () => {
  const nativeSessions = { today: { 'reasonix:session': { client: 'reasonix', totalTokens: 12 } }, month: {}, allTime: {} };
  const nativeProjects = { today: { 'token monitor': { label: 'Token Monitor', tokens: 12, clients: { reasonix: 12 } } }, month: {}, allTime: {} };
  const record = deviceRecordFromAnchor(anchorFixture({ nativeSessions, nativeProjects }), seedOptions());

  assert.deepEqual(record.nativeSessions, nativeSessions);
  assert.deepEqual(record.nativeProjects, nativeProjects);
});

test('the seed removes legacy Reasonix stats paths from ordinary period sessions', () => {
  const leaked = 'reasonix:reasonix-stats:/Users/test/.reasonix/stats/2026-08-09.jsonl';
  const month = periodWith(10);
  month.sessions = {
    [leaked]: { client: 'reasonix', sessionId: leaked, totalTokens: 10 }
  };
  const record = deviceRecordFromAnchor(anchorFixture({ month }), seedOptions());

  assert.deepEqual(record.month.sessions, {});
});

test('an anchor from another local day seeds the previous run’s record', () => {
  // A reboot across midnight leaves yesterday's anchor behind, and the collector
  // cannot use it as a delta base — its arithmetic needs the same local day. The
  // widget has no such arithmetic, and an empty card until the first full scan
  // lands is the wait this path exists to remove.
  const record = deviceRecordFromAnchor(anchorFixture({ dateKey: '2026-08-07' }), seedOptions());

  assert.notEqual(record, null);
  // The record is the one the anchor captured: same three periods, so the
  // widget has real numbers on screen instead of zeros.
  assert.equal(record.today.totalTokens, 1_000);
  assert.equal(record.month.totalTokens, 30_000);
  assert.equal(record.allTime.totalTokens, 900_000);
  // The timestamp is the anchor's own, not this run's: the record says how old
  // it is rather than passing an old snapshot off as a fresh one. The widget
  // turns it into the note under the total.
  assert.equal(record.updatedAt, FULL_SCAN_AT);
  assert.equal(record.receivedAt, FULL_SCAN_AT);
  // The windows are this run's, so the kept periods are read as current.
  assert.equal(record.periodWindows.today.key, '2026-08-08');
});

test('a stale seed survives aggregation and still reads as this run', () => {
  const record = deviceRecordFromAnchor(anchorFixture({ dateKey: '2026-08-07' }), seedOptions());
  const seeded = aggregateDevices([record], 0, NOW.getTime());

  // The periods the anchor captured are summed as they are — that is the
  // point of the seed. Without the current windows the aggregate's fallback
  // comparison would call the closed day expired and drop it, which is the
  // zero this path exists to avoid.
  assert.equal(seeded.periods.today.totalTokens, 1_000);
  assert.equal(seeded.periods.month.totalTokens, 30_000);
  assert.equal(seeded.periods.allTime.totalTokens, 900_000);
});

test('an anchor that cannot describe the current configuration is refused', () => {
  // The collector drops these anchors on load, so seeding from one would put
  // the old configuration's totals on screen and then silently drop them.
  assert.equal(deviceRecordFromAnchor(null, seedOptions()), null);
  assert.equal(deviceRecordFromAnchor(anchorFixture({ month: null }), seedOptions()), null);
  // Age alone no longer refuses an anchor; a moved configuration still does.
  assert.equal(deviceRecordFromAnchor(anchorFixture({ dateKey: '2026-08-07' }), seedOptions({ clients: 'claude' })), null);
  assert.equal(deviceRecordFromAnchor(anchorFixture({ dateKey: '2026-08-07' }), seedOptions({ allTimeSince: '2025-01-01' })), null);
  assert.equal(deviceRecordFromAnchor(anchorFixture({ dateKey: '2026-08-07' }), seedOptions({ projectsEnabled: false })), null);
});

test('an anchor whose capture time cannot be trusted is refused', () => {
  // The timestamp becomes updatedAt and the instant the archive projection is
  // evaluated at, so a snapshot of unknown age must not pass as one taken now.
  assert.equal(deviceRecordFromAnchor(anchorFixture({ fullScanAt: undefined }), seedOptions()), null);
  assert.equal(deviceRecordFromAnchor(anchorFixture({ fullScanAt: 'not-a-timestamp' }), seedOptions()), null);

  const future = new Date(NOW.getTime() + 60_000).toISOString();
  assert.equal(deviceRecordFromAnchor(anchorFixture({ fullScanAt: future }), seedOptions()), null);

  // Old but trustworthy still seeds, and keeps its own timestamp rather than
  // being restamped as fresh.
  const earlier = new Date(NOW.getTime() - 6 * 60 * 60 * 1000).toISOString();
  const record = deviceRecordFromAnchor(anchorFixture({ fullScanAt: earlier }), seedOptions());
  assert.equal(record.updatedAt, earlier);
  assert.equal(record.receivedAt, earlier);
});

test('an anchor the collector would discard is refused here too', () => {
  // Same day, but the config moved. The collector drops this anchor on load, so
  // seeding from it would put the old client set's totals on screen for the
  // length of the first scan and then silently drop them.
  const dropped = deviceRecordFromAnchor(anchorFixture(), seedOptions({ clients: 'claude' }));
  assert.equal(dropped, null);

  const rescoped = deviceRecordFromAnchor(anchorFixture(), seedOptions({ allTimeSince: '2025-01-01' }));
  assert.equal(rescoped, null);

  const reprojected = deviceRecordFromAnchor(anchorFixture(), seedOptions({ projectsEnabled: false }));
  assert.equal(reprojected, null);
});

test('the WSL bundle is summed in, and only while WSL scanning is on', () => {
  // The anchor stores host periods and WSL separately, so a seed that forgot the
  // bundle would read low on Windows and then jump when the first scan lands.
  const wslBundle = { today: periodWith(400), month: periodWith(9_000), allTime: periodWith(100_000) };

  const merged = deviceRecordFromAnchor(anchorFixture({ wslBundle }), seedOptions());
  assert.equal(merged.today.totalTokens, 1_400);
  assert.equal(merged.month.totalTokens, 39_000);
  assert.equal(merged.allTime.totalTokens, 1_000_000);

  const hostOnly = deviceRecordFromAnchor(anchorFixture({ wslBundle }), seedOptions({ wslScanEnabled: false }));
  assert.equal(hostOnly.today.totalTokens, 1_000);
  assert.equal(hostOnly.allTime.totalTokens, 900_000);
});

test('the seeded totals survive aggregation once the UTC day has rolled over', () => {
  // Local 2026-08-08 is still 2026-08-07 in UTC when the anchor is written, so
  // aggregateDevices' fallback comparison would call today's window expired and
  // drop the period entirely, leaving exactly the zero this seeding exists to
  // avoid. periodWindows is what keeps that comparison off the fallback.
  const record = deviceRecordFromAnchor(anchorFixture(), seedOptions());
  assert.equal(record.periodWindows.today.key, '2026-08-08');

  const seeded = aggregateDevices([record], 0, NOW.getTime());
  assert.equal(seeded.periods.today.totalTokens, 1_000);
  assert.equal(seeded.periods.month.totalTokens, 30_000);

  const withoutWindows = { ...record };
  delete withoutWindows.periodWindows;
  const bare = aggregateDevices([withoutWindows], 0, NOW.getTime());
  assert.equal(bare.periods.today.totalTokens, 0, 'guards the fallback this test exists for');
});
