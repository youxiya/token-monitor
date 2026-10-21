'use strict';

const { anchorConfigTrust, computePeriodWindows, qoderCnSourcesForClients } = require('./collector');
const { mergePeriods } = require('./usage');
const { filterReasonixSyntheticSessions } = require('./providers/reasonix/sessionGuard');

// The collector persists every full scan to collector-anchor.json so it can
// derive month/allTime from a `--today` scan after a restart. A widget cold
// start reuses that same file for a second purpose: putting real numbers on
// screen immediately instead of zeros for the length of the first full scan
// (today + month + `--since allTimeSince`, run serially to avoid the CPU spike
// from issue #15).
//
// Whether the anchor may be reused at all is the configuration question, and
// that is shared with the collector through anchorConfigTrust so the two
// cannot drift: an anchor the collector is about to discard would otherwise
// show the previous configuration's totals for a minute and then drop them,
// which reads as a counting bug rather than a seed being replaced.
//
// The anchor's AGE is the seed's own rule, and it is deliberately looser than
// the collector's. The collector needs a same-day anchor because
// applyPeriodDelta subtracts the anchor's today bucket from a fresh scan, and
// that subtraction only means something when both describe the same day. A
// widget that shows the last known totals while its first scan runs has no
// such arithmetic.
//
// An older anchor therefore still seeds, and it seeds the record as it was:
// the same three periods, with the anchor's own capture time as the record's
// timestamp. The widget shows the last known numbers instead of zeros, and
// the age of that record is what tells the reader they are looking at the
// previous run rather than a live reading — the caller marks it (see
// primeLocalStatsFromAnchor), because only it knows the seed is on screen.
//
// Returns a device record, or null when the anchor cannot be used.
function deviceRecordFromAnchor(saved, options = {}) {
  const {
    envelope = {},
    clients = '',
    allTimeSince = '',
    projectsEnabled = true,
    qoderCnDbPath: qoderCnDbPathOption,
    qoderCnProjectsDir: qoderCnProjectsDirOption,
    customScanPaths = null,
    homeDir,
    env,
    sourcePlatform,
    wslScanEnabled = true,
    wslSupported = false,
    hostname = '',
    platform = '',
    now = new Date()
  } = options;
  const qoderCnSources = qoderCnSourcesForClients(clients, { homeDir, env, platform: sourcePlatform });
  const qoderCnDbPath = qoderCnDbPathOption === undefined ? qoderCnSources.dbPath : qoderCnDbPathOption;
  const qoderCnProjectsDir = qoderCnProjectsDirOption === undefined ? qoderCnSources.projectsDir : qoderCnProjectsDirOption;
  const trust = anchorConfigTrust(saved, { ...options, platform: sourcePlatform || process.platform, clients, allTimeSince, projectsEnabled, qoderCnDbPath, qoderCnProjectsDir, customScanPaths, now });
  if (!trust) return null;
  // The seed's own rule, and the one place it is stricter than the collector.
  // A capture time the collector cannot trust only costs it a full scan, but
  // here that timestamp becomes the record's updatedAt and the instant the
  // archive projection is evaluated at, so a snapshot of unknown age must not
  // be presented as one taken now.
  if (trust.capturedAtMs === null) return null;
  // The anchor's three periods are the record: a same-day anchor describes
  // today, an older one describes the closed day it captured. Either way the
  // record carries the anchor's own timestamp, and the widget marks the age
  // so a previous run's numbers are not read as a live reading.
  // The anchor keeps host periods and the WSL bundle apart, the way
  // collectUsageOnce does before summing them. Same local day is established
  // above, so all three windows are safe to merge.
  const wsl = wslScanEnabled !== false ? saved.wslBundle : null;
  const cleanPeriod = (period) => {
    if (!period || typeof period !== 'object' || !Object.prototype.hasOwnProperty.call(period, 'sessions')) return period;
    const sessions = filterReasonixSyntheticSessions(period.sessions);
    return sessions === period.sessions ? period : { ...period, sessions };
  };
  const withWsl = (period, wslPeriod) => cleanPeriod(wslPeriod ? mergePeriods(period, wslPeriod) : period);
  const today = withWsl(saved.today, wsl?.today);
  const month = withWsl(saved.month, wsl?.month);
  const allTime = withWsl(saved.allTime, wsl?.allTime);
  // Mirrors collectUsageOnce: a non-Windows host reports no WSL status at all,
  // a Windows host with scanning off reports it as disabled rather than absent,
  // and otherwise the anchor's own snapshot stands until the first scan. Absent
  // and disabled are different states downstream, so the distinction is kept.
  const wslStatus = !wslSupported
    ? null
    : wslScanEnabled === false
      ? { state: 'disabled', detected: [], withData: [] }
      : (saved.wslStatus || null);
  const at = new Date(trust.capturedAtMs).toISOString();
  return {
    ...envelope,
    hostname,
    platform,
    updatedAt: at,
    receivedAt: at,
    trackedClients: String(clients || '').split(',').filter(Boolean),
    // Both drive UI beyond the totals: projectsEnabled decides whether the
    // all-time project breakdown is flagged incomplete, wslStatus feeds the
    // attribution panel. Leaving them off makes the seed a record that looks
    // subtly unlike the one replacing it.
    projectsEnabled,
    ...(wslStatus ? { wslStatus } : {}),
    // Required, not decorative. Without them aggregateDevices falls back to
    // comparing UTC days, and anywhere ahead of UTC a local day that has not
    // rolled over in UTC yet reads as an expired window: today's tokens get
    // dropped and the card shows the zero this whole path exists to avoid.
    // The windows are this run's, not the anchor's: they say which day the
    // record is being read as, and a period the anchor does not carry is
    // empty rather than expired, so it is neither summed nor dropped.
    periodWindows: computePeriodWindows(now),
    // A closed day contributes nothing. The key is omitted rather than set to
    // an empty period so the record reads as "no data for this window yet".
    ...(today ? { today } : {}),
    ...(month ? { month } : {}),
    ...(allTime ? { allTime } : {}),
    ...(Object.prototype.hasOwnProperty.call(saved, 'nativeSessions') ? { nativeSessions: saved.nativeSessions } : {}),
    ...(Object.prototype.hasOwnProperty.call(saved, 'nativeProjects') ? { nativeProjects: saved.nativeProjects } : {})
  };
}

module.exports = {
  deviceRecordFromAnchor
};
