'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseDrive, evaluateDrives, driveLine } = require('../src/main/drives/health');
const { checkDrives, candidates } = require('../src/main/drives/smartctl');

// Trimmed-down `smartctl -j -x` output, shaped like smartmontools 7.x JSON.
const ok = { smartctl: { version: [7, 5], exit_status: 0 } };
const ataAttrs = (rows) => ({ ata_smart_attributes: { table: rows.map(([id, name, value, raw, when_failed = '']) => ({ id, name, value, worst: value, thresh: 10, when_failed, raw: { value: raw } })) } });

const NVME_OK = {
  ...ok,
  device: { name: '/dev/nvme0', type: 'nvme', protocol: 'NVMe' },
  model_name: 'SAMSUNG MZVL2512HCJQ',
  serial_number: 'S675NX0T123456',
  firmware_version: 'GXA7801Q',
  nvme_total_capacity: 512110190592,
  smart_status: { passed: true, nvme: { value: 0 } },
  nvme_smart_health_information_log: {
    critical_warning: 0,
    temperature: 38,
    available_spare: 100,
    available_spare_threshold: 10,
    percentage_used: 3,
    data_units_written: 20000000,
    power_cycles: 1500,
    power_on_hours: 4200,
    media_errors: 0,
    num_err_log_entries: 12, // common and harmless on NVMe: not a warning
  },
  power_on_time: { hours: 4200 },
  temperature: { current: 38 },
};

const SATA_SSD = {
  ...ok,
  device: { name: '/dev/sda', type: 'sat', protocol: 'ATA' },
  model_name: 'Samsung SSD 860 EVO 500GB',
  serial_number: 'S3Z1NB0K000001',
  user_capacity: { bytes: 500107862016 },
  rotation_rate: 0,
  smart_support: { available: true, enabled: true },
  smart_status: { passed: true },
  ...ataAttrs([
    [5, 'Reallocated_Sector_Ct', 100, 0],
    [9, 'Power_On_Hours', 95, 21000],
    [177, 'Wear_Leveling_Count', 92, 120],
    [199, 'UDMA_CRC_Error_Count', 100, 3],
  ]),
  power_on_time: { hours: 21000 },
  temperature: { current: 31 },
};

const HDD_PENDING = {
  smartctl: { version: [7, 5], exit_status: 64 },
  device: { name: '/dev/sdb', type: 'sat', protocol: 'ATA' },
  model_name: 'WDC WD10JPVX-22JC3T0',
  serial_number: 'WD-WX11A12345',
  user_capacity: { bytes: 1000204886016 },
  rotation_rate: 5400,
  smart_support: { available: true, enabled: true },
  smart_status: { passed: true },
  ...ataAttrs([
    [5, 'Reallocated_Sector_Ct', 199, 8],
    [197, 'Current_Pending_Sector', 200, 16],
    [198, 'Offline_Uncorrectable', 200, 16],
  ]),
  ata_smart_error_log: { summary: { count: 4 } },
  power_on_time: { hours: 30500 },
};

const NVME_WORN = {
  smartctl: { version: [7, 5], exit_status: 8 },
  device: { name: '/dev/nvme1', type: 'nvme', protocol: 'NVMe' },
  model_name: 'Generic NVMe',
  serial_number: 'WORN0001',
  smart_status: { passed: false, nvme: { value: 1 } },
  nvme_smart_health_information_log: { critical_warning: 1, available_spare: 5, available_spare_threshold: 10, percentage_used: 104, media_errors: 0, temperature: 45 },
};

const DENIED = {
  smartctl: { version: [7, 5], exit_status: 2, messages: [{ string: 'Smartctl open device: /dev/sda failed: Permission denied', severity: 'error' }] },
  device: { name: '/dev/sda', type: 'sat', protocol: 'ATA' },
};

test('healthy NVMe drive passes with wear, hours and data written', () => {
  const d = parseDrive(NVME_OK);
  assert.equal(d.status, 'pass');
  assert.equal(d.kind, 'NVMe SSD');
  assert.equal(d.capacity, '512 GB');
  assert.equal(d.lifeRemaining, 97);
  assert.equal(d.powerOnHours, 4200);
  assert.equal(d.bytesWritten, 20000000 * 512000);
  assert.ok(d.checks.every((c) => c.status === 'ok'), JSON.stringify(d.checks));
});

test('SATA SSD: wear from the vendor attribute, CRC errors only warn', () => {
  const d = parseDrive(SATA_SSD);
  assert.equal(d.kind, 'SSD');
  assert.equal(d.lifeRemaining, 92);
  assert.match(d.wearSource, /177/);
  assert.equal(d.status, 'warn');
  assert.equal(d.checks.find((c) => c.label === 'Interface CRC errors').status, 'warn');
});

test('device statistics endurance wins over vendor attributes', () => {
  const json = {
    ...SATA_SSD,
    ata_device_statistics: { pages: [{ table: [{ name: 'Percentage Used Endurance Indicator', value: 15, flags: { valid: true } }] }] },
  };
  const d = parseDrive(json);
  assert.equal(d.lifeRemaining, 85);
  assert.equal(d.wearSource, 'device statistics');
});

test('HDD with pending/uncorrectable sectors fails even though SMART says passed', () => {
  const d = parseDrive(HDD_PENDING);
  assert.equal(d.kind, 'HDD');
  assert.equal(d.status, 'fail');
  assert.equal(d.lifeRemaining, null, 'HDDs have no wear percentage');
  const byLabel = Object.fromEntries(d.checks.map((c) => [c.label, c.status]));
  assert.equal(byLabel['Pending sectors'], 'fail');
  assert.equal(byLabel['Uncorrectable sectors'], 'fail');
  assert.equal(byLabel['Reallocated sectors'], 'warn');
  assert.equal(byLabel['Logged ATA errors'], 'warn');
});

test('a prefail attribute below threshold now fails the drive', () => {
  const d = parseDrive({ ...SATA_SSD, ...ataAttrs([[5, 'Reallocated_Sector_Ct', 5, 4000, 'now']]) });
  assert.equal(d.status, 'fail');
  assert.ok(d.checks.some((c) => c.label === 'Attributes below threshold' && c.status === 'fail'));
});

test('worn-out NVMe: critical warning bits decoded, life floored at 0', () => {
  const d = parseDrive(NVME_WORN);
  assert.equal(d.status, 'fail');
  assert.equal(d.lifeRemaining, 0);
  assert.match(d.checks.find((c) => c.label === 'Critical warnings').value, /spare capacity/);
  assert.equal(d.checks.find((c) => c.label === 'Available spare').status, 'fail');
  assert.equal(d.checks.find((c) => c.label === 'SMART self-assessment').value, 'FAILING');
});

test('permission denied is "not readable", flagged as needing admin', () => {
  const d = parseDrive(DENIED);
  assert.equal(d.status, 'unknown');
  assert.equal(d.needsAdmin, true);
  assert.match(d.reason, /administrator/);
});

test('USB bridge device types are external', () => {
  assert.equal(parseDrive(NVME_OK, { name: '/dev/sdc', type: 'sntjmicron' }).external, true);
  assert.equal(parseDrive(NVME_OK, { name: '/dev/nvme0', type: 'nvme' }).external, false);
});

test('verdict: pass, fail, unreadable, removed drive, external-only', () => {
  const pass = parseDrive(NVME_OK);
  const fail = parseDrive(HDD_PENDING);
  const unreadable = parseDrive(DENIED);
  const ext = parseDrive(HDD_PENDING, {}, { external: true });

  assert.equal(evaluateDrives([pass]).status, 'pass');
  const warned = evaluateDrives([pass, parseDrive(SATA_SSD)]);
  assert.equal(warned.status, 'pass');
  assert.equal(warned.warnings.length, 1);

  const f = evaluateDrives([pass, fail]);
  assert.equal(f.status, 'fail');
  assert.match(f.summary, /Pending sectors 16/);

  assert.equal(evaluateDrives([pass, unreadable]).status, null, 'an unreadable internal drive blocks an automatic pass');
  assert.equal(evaluateDrives([pass, ext]).status, 'pass', 'external drives are not counted');
  assert.equal(evaluateDrives([ext], { internalInInventory: 0 }).status, 'na');
  assert.equal(evaluateDrives([], { internalInInventory: 1 }).status, null);
});

test('driveLine is a compact one-liner for the report', () => {
  assert.equal(driveLine(parseDrive(NVME_OK)), 'SAMSUNG MZVL2512HCJQ 512 GB [S675NX0T123456]: PASS / 97% life / 4,200 h');
  assert.match(driveLine({ name: '/dev/sdz', status: 'unknown', external: false }), /not readable/);
});

test('checkDrives: scans, de-duplicates, spots USB drives by serial, summarizes', async () => {
  const outputs = {
    '--version': { smartctl: { version: [7, 5] } },
    '--scan-open': {
      devices: [
        { name: '/dev/nvme0', type: 'nvme' },
        { name: '/dev/sda', type: 'sat' },
        { name: '/dev/sda', type: 'sat' }, // listed twice
        { name: '/dev/sg1', type: 'scsi' }, // same drive as /dev/sda by serial
        { name: 'IOService:/apple', type: 'nvme' }, // reports no capacity
      ],
    },
    '/dev/nvme0': NVME_OK,
    '/dev/sda': HDD_PENDING,
    '/dev/sg1': HDD_PENDING,
    'IOService:/apple': { ...ok, device: { protocol: 'NVMe' }, model_name: 'APPLE SSD AP2048R', serial_number: 'APPLE1', smart_status: { passed: true }, nvme_smart_health_information_log: { critical_warning: 0, percentage_used: 1 } },
  };
  const calls = [];
  const run = async (_bin, args) => {
    calls.push(args);
    return { json: outputs[args[args.length - 1]] };
  };
  const res = await checkDrives({
    run,
    locate: () => ({ file: path.join('/opt', 'vendor', 'smartctl'), source: 'bundled' }),
    inventory: [{ serial: 'WD-WX11A12345', removable: true }, { serial: 'S675NX0T123456', removable: false }, { serial: 'APPLE1', sizeBytes: 2e12, capacity: '2 TB', removable: false }],
    platform: 'darwin',
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.tool, { source: 'bundled', version: '7.5', file: 'vendor/smartctl' });
  assert.equal(res.drives.length, 3);
  assert.equal(res.drives[2].capacity, '2 TB', 'capacity filled in from the inventory by serial');
  assert.equal(res.drives[1].external, true, 'matched a removable inventory serial');
  assert.equal(res.verdict.status, 'pass', 'the failing drive is external, so not counted');
  assert.ok(res.drives.every((d) => typeof d.line === 'string'));
  assert.deepEqual(calls[2], ['-j', '-x', '-d', 'nvme', '/dev/nvme0']);
});

test('checkDrives: missing tool and failed reads are reported, not thrown', async () => {
  const missing = await checkDrives({ locate: () => null });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'smartctl-missing');

  const res = await checkDrives({
    locate: () => ({ file: 'smartctl', source: 'system' }),
    run: async (_b, args) => (args.includes('--scan-open') ? { json: { devices: [{ name: '/dev/sda', type: 'sat' }] } } : args.includes('--version') ? { json: {} } : { error: 'smartctl timed out after 30 s' }),
  });
  assert.equal(res.drives[0].status, 'unknown');
  assert.match(res.drives[0].reason, /timed out/);
  assert.equal(res.verdict.status, null);
});

test('bundled smartctl is preferred over a system copy', () => {
  const list = candidates({ resourcesPath: '/app/resources', appRoot: '/src', platform: 'linux', env: { PATH: '/usr/bin' } });
  assert.deepEqual(list.slice(0, 3).map((c) => [c.file, c.source]), [
    [path.join('/app/resources', 'smartctl', process.platform === 'win32' ? 'smartctl.exe' : 'smartctl'), 'bundled'],
    [path.join('/src', 'vendor', 'smartctl', `linux-${process.arch}`, process.platform === 'win32' ? 'smartctl.exe' : 'smartctl'), 'bundled'],
    [path.join('/usr/bin', process.platform === 'win32' ? 'smartctl.exe' : 'smartctl'), 'system'],
  ]);
});
