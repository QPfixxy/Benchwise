'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const u = require('../src/main/hardware/usbtree');
const td = require('../src/main/ports/testdrive');

// Trimmed real output of `system_profiler SPUSBHostDataType -json` (macOS 27).
const MAC_JSON = JSON.stringify({
  SPUSBHostDataType: [
    {
      _items: [
        { _name: 'TBT-UDM', USBDeviceKeyLinkSpeed: '12 Mb/s', USBDeviceKeyVendorID: '0x2230', USBDeviceKeyProductID: '0x2044', USBDeviceKeySerialNumber: '11AD1D0A07FC7E030C1D0B00', USBKeyLocationID: '0x00110000' },
        {
          _name: 'USB2.0 Hub',
          USBDeviceKeyLinkSpeed: '480 Mb/s',
          USBKeyLocationID: '0x00140000',
          USBDeviceKeySerialNumber: '000000001',
          _items: [{ _name: '2.4G Wireless Keyboard', USBDeviceKeyLinkSpeed: '12 Mb/s', USBDeviceKeySerialNumber: 'Not Provided', USBKeyLocationID: '0x00144100' }],
        },
        { _name: 'Ultra USB 3.0', USBDeviceKeyLinkSpeed: '5 Gb/s', USBDeviceKeyVendorID: '0x0781', USBDeviceKeyProductID: '0x5583', USBDeviceKeySerialNumber: '4C530001', USBKeyLocationID: '0x00200000' },
      ],
    },
  ],
});

test('macOS USB tree: location, link speed, hubs, junk serials', () => {
  const list = u.parseMacUsb(MAC_JSON);
  assert.equal(list.length, 4);
  const stick = list.find((d) => d.name === 'Ultra USB 3.0');
  assert.equal(stick.location, '0x00200000');
  assert.equal(stick.speedMbps, 5000);
  assert.equal(stick.speed, 'USB 3 SuperSpeed (5 Gb/s)');
  assert.equal(stick.vendorId, '0781');
  assert.equal(list.find((d) => d.name === 'USB2.0 Hub').hub, true);
  assert.equal(list.find((d) => d.name === '2.4G Wireless Keyboard').serial, null); // "Not Provided"
  assert.deepEqual(u.parseMacUsb('not json'), []);
});

test('older macOS SPUSBDataType format', () => {
  const list = u.parseMacUsb({ SPUSBDataType: [{ _items: [{ _name: 'Cruzer', location_id: '0x14100000 / 3', device_speed: 'high_speed', serial_num: 'ABC', vendor_id: '0x0781  (SanDisk)' }] }] });
  assert.equal(list[0].location, '0x14100000');
  assert.equal(list[0].speedMbps, 480);
  assert.equal(list[0].vendorId, '0781');
});

test('Linux sysfs entry: port path is the location, hubs by class', () => {
  const d = u.parseLinuxUsbEntry('2-1.3', { manufacturer: 'SanDisk', product: 'Ultra', idVendor: '0781', idProduct: '5583', serial: '4C53', speed: '5000', bDeviceClass: '00' });
  assert.equal(d.location, '2-1.3');
  assert.equal(d.speedMbps, 5000);
  assert.equal(d.name, 'SanDisk Ultra');
  assert.equal(u.parseLinuxUsbEntry('1-1', { product: 'Hub', bDeviceClass: '09', speed: '480' }).hub, true);
  assert.ok(u.LINUX_PORT.test('3-1.4.2') && !u.LINUX_PORT.test('usb1') && !u.LINUX_PORT.test('1-1:1.0'));
});

test('Windows PnP rows: VID/PID, serial vs. generated ID, location per hub', () => {
  const rows = [
    { id: 'USB\\VID_0781&PID_5583\\4C530001230', name: 'USB Mass Storage Device', cls: 'USB', loc: 'Port_#0002.Hub_#0001', parent: 'USB\\ROOT_HUB30\\4&2A4B&0' },
    { id: 'USB\\VID_046D&PID_C52B\\5&1F2A&0&3', name: 'USB Composite Device', cls: 'USB', loc: 'Port_#0003.Hub_#0001' },
    { id: 'USB\\VID_8087&PID_0026\\5&1F2A&0&10', name: 'Generic USB Hub', cls: 'USB' },
  ];
  const list = u.parseWindowsUsb(JSON.stringify(rows));
  assert.equal(list[0].serial, '4C530001230');
  assert.equal(list[0].vendorId, '0781');
  assert.equal(list[0].location, 'Port_#0002.Hub_#0001 @ 4&2A4B&0');
  assert.equal(list[1].serial, null); // Windows-generated instance ID, not a serial
  assert.equal(list[2].hub, true);
  assert.equal(u.parseWindowsUsb(JSON.stringify(rows[0])).length, 1); // single object, not array
});

test('identifyStick: diff on first insertion, remembered serial afterwards', () => {
  const before = u.parseMacUsb(MAC_JSON).filter((d) => d.name !== 'Ultra USB 3.0');
  const after = u.parseMacUsb(MAC_JSON);
  const stick = u.identifyStick(before, after, null);
  assert.equal(stick.name, 'Ultra USB 3.0');
  // Same stick in another port: different location, found by serial even if the baseline already has noise.
  const moved = after.map((d) => (d.name === 'Ultra USB 3.0' ? { ...d, location: '0x00300000', key: 'x' } : d));
  assert.equal(u.identifyStick(after, moved, { serial: '4C530001' }).location, '0x00300000');
  assert.equal(u.identifyStick(after, after, null), null); // nothing new
});

function tmpDrive() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'benchwise-drive-'));
}

test('prepare + benchmark: verifies data and measures speed; detects corruption', async () => {
  const mount = tmpDrive();
  const mountsFn = async () => [mount];
  const marker = await td.prepareDrive(mount, { mountsFn, bytes: 2 * 1024 * 1024 });
  assert.equal((await td.findTestDrives(mountsFn)).length, 1);

  const ok = await td.benchmark(mount, marker);
  assert.equal(ok.verified, true, ok.error);
  assert.ok(ok.readMBps > 0 && ok.writeMBps > 0);
  assert.equal(fs.existsSync(path.join(mount, 'BENCHWISE-TEST-DRIVE', 'write-test.tmp')), false); // cleaned up

  // Flip one byte: the integrity check must fail.
  const f = path.join(mount, 'BENCHWISE-TEST-DRIVE', 'read-test.bin');
  const buf = fs.readFileSync(f);
  buf[1000] ^= 0xff;
  fs.writeFileSync(f, buf);
  const bad = await td.benchmark(mount, marker);
  assert.equal(bad.verified, false);
  assert.match(bad.error, /corrupt/i);
});

test('drives prepared under the old Qudit name are still recognized and tested', async () => {
  const mount = tmpDrive();
  const mountsFn = async () => [mount];
  const marker = await td.prepareDrive(mount, { mountsFn, bytes: 1024 * 1024 });
  // Lay the drive out the way Qudit 2.0 did.
  fs.renameSync(path.join(mount, 'BENCHWISE-TEST-DRIVE'), path.join(mount, 'QUDIT-TEST-DRIVE'));
  fs.rmSync(path.join(mount, td.MARKER));
  const { benchwise, ...rest } = marker;
  const legacy = { ...rest, qudit: 'test-drive', readFile: 'QUDIT-TEST-DRIVE/read-test.bin' };
  fs.writeFileSync(path.join(mount, 'QUDIT-TEST-DRIVE.json'), JSON.stringify(legacy));

  const found = await td.findTestDrives(mountsFn);
  assert.equal(found.length, 1);
  const r = await td.benchmark(mount, found[0].marker);
  assert.equal(r.verified, true, r.error);
  assert.ok(r.writeMBps > 0);
  assert.equal(fs.existsSync(path.join(mount, 'BENCHWISE-TEST-DRIVE')), false); // wrote inside the old folder
});

test('a marker pointing outside the drive is rejected', async () => {
  const mount = tmpDrive();
  const r = await td.benchmark(mount, { readFile: '../../etc/hosts', bytes: 1, sha256: 'a'.repeat(64) });
  assert.equal(r.verified, false);
  assert.match(r.error, /outside the drive/);
});

test('prepare refuses volumes that are not in the candidate list', async () => {
  await assert.rejects(td.prepareDrive('/etc', { mountsFn: async () => [] }), /not available/);
});

test('PortWatcher: ignores drives present at start, records each new insertion once', async () => {
  let drives = [{ mount: '/Volumes/QTEST', marker: {} }];
  let usb = [{ key: 'kb', name: 'Keyboard', hub: false }];
  const stick = (loc) => ({ key: `s-${loc}`, location: loc, name: 'Ultra', serial: 'S1', speed: 'USB 3', speedMbps: 5000, hub: false });
  const w = new td.PortWatcher({
    findTestDrives: async () => drives,
    snapshotUsb: async () => usb,
    benchmark: async () => ({ verified: true, readMBps: 100, writeMBps: 50, error: null }),
    eject: async () => true,
  });
  const settle = () => new Promise((r) => setTimeout(r, 10));

  let s = await w.start();
  assert.deepEqual(s.waitingRemoval, ['/Volumes/QTEST']);
  s = await w.poll();
  assert.equal(s.results.length, 0); // already plugged in at start: not a test

  drives = []; // unplugged
  await w.poll();
  usb = [...usb, stick('A')];
  drives = [{ mount: '/Volumes/QTEST', marker: {} }]; // plugged into port A
  await w.poll();
  await settle();
  s = await w.poll(); // still mounted: no duplicate run
  assert.equal(s.results.length, 1);
  assert.equal(s.results[0].location, 'A');

  drives = [];
  usb = usb.filter((d) => d.location !== 'A');
  await w.poll();
  usb = [...usb, stick('B')];
  drives = [{ mount: '/Volumes/QTEST', marker: {} }];
  await w.poll();
  await settle();
  s = await w.poll();
  assert.deepEqual(s.ports.map((p) => p.location), ['A', 'B']);
});
