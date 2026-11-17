'use strict';

// Pure functions: smartctl JSON (`smartctl -j -x`) -> drive record + checks,
// and the checks -> a Drive Health verdict. No I/O here, so it's unit-tested
// against captured smartctl output.

const { formatStorage } = require('../hardware/normalize');

// Pass/fail limits. Only clear signs of a failing drive fail it; wear and
// history that a buyer should know about are warnings.
const LIMITS = Object.freeze({
  wearWarnPct: 80, // % of rated endurance used
  wearFailPct: 100,
  reallocatedFail: 100, // reallocated sectors; any at all is a warning
  tempWarnC: 70,
});

// smartctl exit status bits (see `man smartctl`, EXIT STATUS).
const EXIT = { CMDLINE: 1, OPEN: 2, COMMAND: 4, FAILING: 8, PREFAIL: 16, PAST: 32, ERRLOG: 64, SELFTEST: 128 };

// USB bridges smartctl talks through: always an external drive.
const USB_TYPES = /^(usb|snt)/i;

const NVME_CRITICAL = [
  'spare capacity below threshold',
  'temperature outside safe range',
  'reliability degraded by media or internal errors',
  'media placed in read-only mode',
  'volatile memory backup failed',
  'persistent memory region unreliable',
];

// SATA SSD wear attributes whose normalized value is "% life remaining".
const WEAR_ATTRS = [177, 231, 233, 202, 169];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

function attr(json, id) {
  return (json.ata_smart_attributes?.table || []).find((a) => a.id === id) || null;
}
const attrRaw = (json, id) => num(attr(json, id)?.raw?.value);

function devstat(json, name) {
  for (const page of json.ata_device_statistics?.pages || []) {
    const row = (page.table || []).find((r) => r.name === name && r.flags?.valid !== false);
    if (row) return num(row.value);
  }
  return null;
}

function protocolOf(json) {
  const p = String(json.device?.protocol || '').toUpperCase();
  if (p.includes('NVME')) return 'NVMe';
  if (p.includes('ATA')) return 'ATA';
  if (p.includes('SCSI')) return 'SCSI';
  return p || null;
}

function wear(json, protocol, rotation) {
  if (protocol === 'NVMe') {
    const used = num(json.nvme_smart_health_information_log?.percentage_used);
    return used === null ? null : { percentUsed: used, source: 'NVMe health log' };
  }
  if (protocol === 'SCSI') {
    const used = num(json.scsi_percentage_used_endurance_indicator);
    return used === null ? null : { percentUsed: used, source: 'SCSI endurance indicator' };
  }
  if (rotation !== 0) return null; // HDDs don't wear out this way
  const used = devstat(json, 'Percentage Used Endurance Indicator');
  if (used !== null) return { percentUsed: used, source: 'device statistics' };
  for (const id of WEAR_ATTRS) {
    const a = attr(json, id);
    if (a && num(a.value) !== null && a.value <= 100) return { percentUsed: 100 - a.value, source: `attribute ${id} (${a.name})` };
  }
  return null;
}

function bytesWritten(json, protocol) {
  if (protocol === 'NVMe') {
    const units = num(json.nvme_smart_health_information_log?.data_units_written);
    return units === null ? null : units * 512000; // NVMe "data unit" = 1000 x 512 bytes
  }
  const sectors = devstat(json, 'Logical Sectors Written');
  return sectors === null ? null : sectors * (num(json.logical_block_size) || 512);
}

function kindOf(protocol, rotation) {
  if (protocol === 'NVMe') return 'NVMe SSD';
  if (rotation === 0) return 'SSD';
  if (rotation > 0) return 'HDD';
  return null;
}

function messages(json) {
  return (json.smartctl?.messages || []).map((m) => str(m.string)).filter(Boolean);
}

/** True when smartctl couldn't open the device because we aren't admin/root. */
function permissionDenied(json) {
  return messages(json).some((m) => /permission denied|operation not permitted|access is denied|requires root|administrator/i.test(m));
}

/**
 * @param {object} json      smartctl -j -x output for one device
 * @param {object} [scan]    the --scan-open entry ({name, type})
 * @param {object} [opts]    { external: bool, limits }
 */
function parseDrive(json = {}, scan = {}, { external = false, limits = LIMITS } = {}) {
  const protocol = protocolOf(json);
  const rotation = num(json.rotation_rate);
  const exitStatus = num(json.smartctl?.exit_status) ?? 0;
  const nvme = json.nvme_smart_health_information_log || null;
  const type = scan.type || json.device?.type || null;

  const drive = {
    name: scan.name || json.device?.name || null,
    type,
    protocol,
    model: str(json.model_name) || str([json.scsi_vendor, json.scsi_product].filter(Boolean).join(' ')),
    serial: str(json.serial_number),
    firmware: str(json.firmware_version) || str(json.scsi_revision),
    capacityBytes: num(json.user_capacity?.bytes) ?? num(json.nvme_total_capacity) ?? num(json.nvme_namespaces?.[0]?.size?.bytes),
    capacity: null,
    kind: kindOf(protocol, rotation),
    external: Boolean(external) || USB_TYPES.test(type || ''),
    smartAvailable: false,
    smartPassed: typeof json.smart_status?.passed === 'boolean' ? json.smart_status.passed : null,
    powerOnHours: num(json.power_on_time?.hours) ?? num(nvme?.power_on_hours),
    powerCycles: num(json.power_cycle_count) ?? num(nvme?.power_cycles),
    temperatureC: num(json.temperature?.current) ?? num(nvme?.temperature),
    percentUsed: null,
    lifeRemaining: null,
    wearSource: null,
    bytesWritten: bytesWritten(json, protocol),
    exitStatus,
    needsAdmin: false,
    messages: messages(json),
    checks: [],
    status: 'unknown',
    reason: null,
  };
  drive.capacity = formatStorage(drive.capacityBytes);

  const w = wear(json, protocol, rotation);
  if (w) {
    drive.percentUsed = w.percentUsed;
    drive.lifeRemaining = Math.max(0, 100 - w.percentUsed);
    drive.wearSource = w.source;
  }

  if (protocol === 'NVMe') drive.smartAvailable = Boolean(nvme);
  else if (protocol === 'ATA') drive.smartAvailable = Boolean(json.smart_support?.available && json.smart_support?.enabled);
  else drive.smartAvailable = drive.smartPassed !== null;

  // Couldn't read the drive at all.
  if (exitStatus & EXIT.OPEN || (!drive.smartAvailable && drive.smartPassed === null)) {
    drive.needsAdmin = permissionDenied(json);
    drive.reason = drive.needsAdmin
      ? 'Needs administrator access to read this drive.'
      : protocol === 'ATA' && json.smart_support?.available && !json.smart_support?.enabled
        ? 'SMART is turned off on this drive (it can be enabled in the BIOS or with smartctl -s on).'
        : drive.external
          ? 'External drive or adapter that does not pass SMART data through.'
          : drive.messages[0] || 'The drive did not return SMART data.';
    return drive;
  }

  drive.checks = runChecks(json, drive, nvme, limits);
  const order = { ok: 0, warn: 1, fail: 2 };
  const worst = drive.checks.reduce((acc, c) => (order[c.status] > order[acc] ? c.status : acc), 'ok');
  drive.status = worst === 'ok' ? 'pass' : worst;
  return drive;
}

function runChecks(json, drive, nvme, limits) {
  const checks = [];
  const add = (label, value, status, detail) => checks.push({ label, value, status, ...(detail ? { detail } : {}) });

  if (drive.smartPassed !== null) {
    add('SMART self-assessment', drive.smartPassed ? 'Passed' : 'FAILING', drive.smartPassed ? 'ok' : 'fail');
  }

  if (drive.protocol === 'ATA') {
    const failingNow = (json.ata_smart_attributes?.table || []).filter((a) => a.when_failed === 'now');
    const failedPast = (json.ata_smart_attributes?.table || []).filter((a) => a.when_failed === 'past');
    if (failingNow.length) add('Attributes below threshold', failingNow.map((a) => a.name).join(', '), 'fail');
    if (failedPast.length) add('Attributes below threshold in the past', failedPast.map((a) => a.name).join(', '), 'warn');

    const realloc = attrRaw(json, 5);
    if (realloc !== null) {
      add('Reallocated sectors', realloc, realloc >= limits.reallocatedFail ? 'fail' : realloc > 0 ? 'warn' : 'ok');
    }
    const pending = attrRaw(json, 197);
    if (pending !== null) add('Pending sectors', pending, pending > 0 ? 'fail' : 'ok', pending > 0 ? 'Sectors the drive could not read.' : null);
    const offline = attrRaw(json, 198);
    if (offline !== null) add('Uncorrectable sectors', offline, offline > 0 ? 'fail' : 'ok');
    const reported = attrRaw(json, 187);
    if (reported !== null && reported > 0) add('Reported uncorrectable errors', reported, 'warn');
    const crc = attrRaw(json, 199);
    if (crc !== null && crc > 0) add('Interface CRC errors', crc, 'warn', 'Usually a cable or connector problem, not the drive itself.');
    const errlog = num(json.ata_smart_error_log?.extended?.count) ?? num(json.ata_smart_error_log?.summary?.count);
    if (errlog !== null && errlog > 0) add('Logged ATA errors', errlog, 'warn');
  }

  if (drive.protocol === 'NVMe' && nvme) {
    const cw = num(nvme.critical_warning) ?? 0;
    const bits = NVME_CRITICAL.filter((_, i) => cw & (1 << i));
    add('Critical warnings', bits.length ? bits.join('; ') : 'None', bits.length ? 'fail' : 'ok');
    const spare = num(nvme.available_spare);
    const spareMin = num(nvme.available_spare_threshold);
    if (spare !== null) add('Available spare', `${spare}%`, spareMin !== null && spare < spareMin ? 'fail' : 'ok');
    const media = num(nvme.media_errors);
    if (media !== null) add('Media errors', media, media > 0 ? 'fail' : 'ok');
  }

  if (drive.protocol === 'SCSI') {
    const grown = num(json.scsi_grown_defect_list);
    if (grown !== null) add('Grown defects', grown, grown > 0 ? 'warn' : 'ok');
    const log = json.scsi_error_counter_log || {};
    const unc = ['read', 'write', 'verify'].reduce((s, k) => s + (num(log[k]?.total_uncorrected_errors) || 0), 0);
    if (Object.keys(log).length) add('Uncorrected errors', unc, unc > 0 ? 'fail' : 'ok');
  }

  if (drive.percentUsed !== null) {
    add(
      'Life remaining',
      `${drive.lifeRemaining}%`,
      drive.percentUsed >= limits.wearFailPct ? 'fail' : drive.percentUsed >= limits.wearWarnPct ? 'warn' : 'ok',
      drive.percentUsed >= limits.wearFailPct ? 'Rated write endurance is used up.' : null,
    );
  }

  const lastTest = lastSelfTest(json);
  if (lastTest) add('Last self-test', lastTest.text, lastTest.passed ? 'ok' : 'fail');

  if (drive.temperatureC !== null) add('Temperature', `${drive.temperatureC}°C`, drive.temperatureC >= limits.tempWarnC ? 'warn' : 'ok');
  return checks;
}

function lastSelfTest(json) {
  const entry = json.ata_smart_self_test_log?.extended?.table?.[0] || json.ata_smart_self_test_log?.standard?.table?.[0] || json.nvme_self_test_log?.table?.[0];
  if (!entry) return null;
  const result = entry.status || entry.self_test_result || {};
  if (typeof result.passed !== 'boolean') return null; // in progress / aborted by host
  return { passed: result.passed, text: str(result.string) || (result.passed ? 'Completed without error' : 'Failed') };
}

/**
 * Overall Drive Health verdict.
 * @param {object[]} drives       parsed drives
 * @param {object}   [opts]       { internalInInventory: number of internal drives the hardware scan saw }
 * @returns {{status: 'pass'|'fail'|'na'|null, summary, warnings: string[]}}
 */
function evaluateDrives(drives = [], { internalInInventory = null } = {}) {
  const internal = drives.filter((d) => !d.external);
  const label = (d) => [d.model || d.name, d.serial && `(${d.serial})`].filter(Boolean).join(' ');
  const warnings = [];
  for (const d of internal) {
    for (const c of d.checks) if (c.status === 'warn') warnings.push(`${label(d)}: ${c.label} ${c.value}`);
  }

  if (!internal.length) {
    if (internalInInventory === 0) return { status: 'na', summary: 'No internal drive installed.', warnings };
    return { status: null, summary: 'No internal drive could be read. Check that the drive is seated, or record the result by hand.', warnings };
  }
  const failed = internal.filter((d) => d.status === 'fail');
  if (failed.length) {
    const why = failed.map((d) => `${label(d)}: ${d.checks.filter((c) => c.status === 'fail').map((c) => `${c.label} ${c.value}`).join(', ')}`);
    return { status: 'fail', summary: `Failing drive: ${why.join('; ')}.`, warnings };
  }
  const unknown = internal.filter((d) => d.status === 'unknown');
  if (unknown.length) {
    return {
      status: null,
      summary: `Couldn't read health data from ${unknown.map(label).join(', ')}. ${unknown[0].reason || ''}`.trim(),
      warnings,
    };
  }
  const n = internal.length;
  return { status: 'pass', summary: `${n} internal drive${n > 1 ? 's' : ''} healthy${warnings.length ? ', with warnings' : ''}.`, warnings };
}

/** One line per drive for the test result (PDF details column). */
function driveLine(d) {
  const bits = [
    d.status === 'unknown' ? 'not readable' : d.status.toUpperCase(),
    d.lifeRemaining != null ? `${d.lifeRemaining}% life` : null,
    d.powerOnHours != null ? `${d.powerOnHours.toLocaleString('en-US')} h` : null,
    d.external ? 'external, not counted' : null,
  ].filter(Boolean);
  return `${[d.model || d.name, d.capacity].filter(Boolean).join(' ')}${d.serial ? ` [${d.serial}]` : ''}: ${bits.join(' / ')}`;
}

module.exports = { LIMITS, EXIT, parseDrive, evaluateDrives, driveLine, permissionDenied };
