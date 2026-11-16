'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const n = require('../src/main/hardware/normalize');

test('placeholder DMI values are rejected', () => {
  for (const v of ['To be filled by O.E.M.', 'Default string', 'System Serial Number', '0000000', 'XXXXXXXX', '', '  ', null, 'N/A', 'Not Specified']) {
    assert.equal(n.isJunkValue(v), true, JSON.stringify(v));
  }
  for (const v of ['C02XK0ABJG5H', '5CD1234XYZ', 'PF2ABCDE', 'Dell Inc.']) {
    assert.equal(n.isJunkValue(v), false, v);
  }
});

test('serial falls back from system to chassis to baseboard', () => {
  const sys = n.normalizeSystem({
    system: { serial: 'To be filled by O.E.M.', manufacturer: 'System manufacturer', model: 'System Product Name' },
    chassis: { serial: 'Default string' },
    baseboard: { serial: 'MB-12345', manufacturer: 'ASUSTeK', model: 'PRIME B450M' },
  });
  assert.equal(sys.serial, 'MB-12345');
  assert.equal(sys.serialSource, 'baseboard');
  assert.equal(sys.manufacturer, 'ASUSTeK'); // placeholder system vendor replaced by board vendor
  assert.equal(sys.model, 'PRIME B450M');
});

test('storage uses decimal (marketed) units with a single unit suffix', () => {
  assert.equal(n.formatStorage(512110190592), '512 GB'); // original showed "476.94 GB GB"
  assert.equal(n.formatStorage(256060514304), '256 GB');
  assert.equal(n.formatStorage(1000204886016), '1 TB');
  assert.equal(n.formatStorage(2000398934016), '2 TB');
  assert.equal(n.formatStorage(0), null);
});

test('memory uses binary units', () => {
  assert.equal(n.formatMemory(16 * 1024 ** 3), '16 GB');
  assert.equal(n.formatMemory(8 * 1024 ** 3), '8 GB');
});

test('memory total prefers installed modules and reports empty slots', () => {
  const mem = n.normalizeMemory({ total: 16.6e9 }, [
    { size: 8 * 1024 ** 3, bank: 'DIMM A', type: 'DDR4', clockSpeed: 3200, formFactor: 'SODIMM', partNum: 'M471A1K43DB1-CWE' },
    { size: 0, bank: 'DIMM B' },
    { size: 8 * 1024 ** 3, bank: 'DIMM C', type: 'DDR4', clockSpeed: 3200 },
  ]);
  assert.equal(mem.total, '16 GB');
  assert.equal(mem.slotsTotal, 3);
  assert.equal(mem.slotsUsed, 2);
  assert.equal(mem.slots[1].empty, true);
  assert.equal(mem.slots[0].speed, '3200 MT/s');
});

test('battery health uses full-charge vs design capacity, not current charge', () => {
  const b = n.normalizeBattery({
    hasBattery: true,
    designedCapacity: 50000,
    maxCapacity: 41000,
    currentCapacity: 20500, // 50% charged; the original reported this as "41% health"
    percent: 50,
    cycleCount: 312,
    capacityUnit: 'mWh',
  });
  assert.equal(b.healthPercent, 82);
  assert.equal(b.cycleCount, 312);
  assert.equal(b.chargePercent, 50);
  assert.deepEqual(n.normalizeBattery({ hasBattery: false }), { present: false });
});

test('GPU classification', () => {
  const cases = [
    [{ vendor: 'Intel Corporation', model: 'Intel(R) UHD Graphics 620' }, 'integrated'],
    [{ vendor: 'Intel Corporation', model: 'Intel(R) Arc(TM) A770 Graphics', vram: 16384 }, 'discrete'],
    [{ vendor: 'Intel Corporation', model: 'Intel(R) Arc(TM) Graphics' }, 'integrated'],
    [{ vendor: 'NVIDIA', model: 'NVIDIA GeForce RTX 3060 Laptop GPU', vram: 6144 }, 'discrete'],
    [{ vendor: 'Advanced Micro Devices, Inc.', model: 'AMD Radeon RX 6700 XT', vram: 12288 }, 'discrete'], // original said "Integrated"
    [{ vendor: 'Advanced Micro Devices, Inc.', model: 'AMD Radeon(TM) Graphics', vram: 512 }, 'integrated'],
    [{ vendor: 'AMD', model: 'AMD Radeon 780M' }, 'integrated'],
    [{ vendor: 'Apple', model: 'Apple M2', bus: 'Built-In' }, 'integrated'],
    [{ vendor: 'Microsoft', model: 'Microsoft Basic Display Adapter' }, 'virtual'],
    [{ model: 'Unknown' }, 'integrated'], // missing vendor must not crash
  ];
  for (const [c, want] of cases) assert.equal(n.classifyGpu(c), want, c.model);
});

test('all GPUs are kept (the original overwrote all but one)', () => {
  const g = n.normalizeGraphics({
    controllers: [
      { vendor: 'Intel', model: 'Intel UHD Graphics 630' },
      { vendor: 'NVIDIA', model: 'GeForce GTX 1650', vram: 4096 },
      { vendor: 'NVIDIA', model: 'GeForce GTX 1650', vram: 4096 },
    ],
  });
  assert.equal(g.gpus.length, 3);
  assert.equal(g.gpus[1].vram, '4 GB');
  assert.equal(g.gpus[0].vram, null);
});

test('virtual disks are filtered and SMART normalized', () => {
  const d = n.normalizeDisks([
    { name: 'Samsung SSD 970 EVO Plus 500GB', size: 500107862016, type: 'NVMe', interfaceType: 'PCIe', serialNum: 'S4EVNX0N123456', smartStatus: 'Ok' },
    { name: 'Msft Virtual Disk', size: 1e10, type: 'SSD' },
    { name: 'WDC WD10EZEX', size: 1000204886016, type: 'HD', interfaceType: 'SATA', smartStatus: 'Predicted Failure' },
  ]);
  assert.equal(d.length, 2);
  assert.equal(d[0].kind, 'NVMe SSD');
  assert.equal(d[0].capacity, '500 GB');
  assert.equal(d[1].smartStatus, 'FAILING');
  assert.equal(d[1].kind, 'HDD');
});

test('network keeps physical adapters only', () => {
  const nets = n.normalizeNetwork([
    { iface: 'en0', ifaceName: 'en0', mac: 'a4:83:e7:11:22:33', type: 'wireless' },
    { iface: 'lo0', mac: '00:00:00:00:00:00', internal: true },
    { iface: 'docker0', mac: '02:42:ac:11:00:02' },
    { iface: 'vEthernet', mac: '00:15:5d:01:02:03', virtual: true },
  ]);
  assert.deepEqual(nets.map((x) => x.mac), ['A4:83:E7:11:22:33']);
  assert.equal(nets[0].type, 'Wi-Fi');
});

test('macOS hardware ports: real MACs kept, bridge/Thunderbolt/virtual dropped', () => {
  const text = [
    'Hardware Port: Ethernet Adapter (en4)\nDevice: en4\nEthernet Address: 56:da:45:ce:e5:46',
    'Hardware Port: Thunderbolt Bridge\nDevice: bridge0\nEthernet Address: 36:f6:a9:a8:c7:40',
    'Hardware Port: Wi-Fi\nDevice: en0\nEthernet Address: a4:5e:60:00:00:01',
    'Hardware Port: Thunderbolt 1\nDevice: en1\nEthernet Address: 36:f6:a9:a8:c7:40',
    'Hardware Port: USB 10/100/1000 LAN\nDevice: en7\nEthernet Address: 00:e0:4c:68:01:02',
    'VLAN Configurations\n===================',
  ].join('\n\n');
  const nets = n.normalizeNetwork(n.parseMacHardwarePorts(text), { hardwareOnly: true });
  assert.deepEqual(
    nets.map((x) => [x.type, x.name, x.mac]),
    [
      ['Wi-Fi', 'Wi-Fi', 'A4:5E:60:00:00:01'],
      ['Ethernet', 'USB 10/100/1000 LAN', '00:E0:4C:68:01:02'],
    ],
  );
});

test('overall status', () => {
  assert.equal(n.overallStatus({ a: { status: 'pass' }, b: { status: 'na' } }), 'pass');
  assert.equal(n.overallStatus({ a: { status: 'pass' }, b: { status: 'untested' } }), 'incomplete');
  assert.equal(n.overallStatus({ a: { status: 'fail' }, b: { status: 'untested' } }), 'fail');
});

test('asset tags are validated server-side against path traversal and shop format', () => {
  assert.equal(n.validateAssetTag('../../etc/passwd').ok, false); // original wrote this as a filename
  assert.equal(n.validateAssetTag('a/b').ok, false);
  assert.equal(n.validateAssetTag('').ok, false);
  assert.equal(n.validateAssetTag('1234567-7654321', '\\d{7}-\\d{7}').ok, true);
  assert.equal(n.validateAssetTag('1234567-765432', '\\d{7}-\\d{7}').ok, false);
  assert.equal(n.validateAssetTag('1234567-7654321x', '\\d{7}-\\d{7}').ok, false); // anchored
  assert.equal(n.validateAssetTag('ok', '(').ok, false); // bad pattern reported, not thrown
});

test('form factor: firmware chassis first, then Apple model name, then battery', () => {
  const ff = (o) => n.classifyFormFactor(o).formFactor;
  const cases = [
    [{ chassisType: 'Notebook' }, 'laptop'],
    [{ chassisType: 'Laptop' }, 'laptop'],
    [{ chassisType: 'Convertible' }, 'laptop'],
    [{ chassisType: 'Detachable' }, 'laptop'],
    [{ chassisType: 'Tablet' }, 'tablet'],
    [{ chassisType: 'All in One' }, 'all-in-one'],
    [{ chassisType: 'Desktop' }, 'desktop'],
    [{ chassisType: 'Mini Tower' }, 'desktop'],
    [{ chassisType: 'Low Profile Desktop' }, 'desktop'],
    [{ chassisType: 'Space-saving' }, 'desktop'],
    [{ chassisType: 'Mini PC' }, 'desktop'],
    [{ chassisType: 'Main Server Chassis' }, 'server'],
    [{ chassisType: 'Rack Mount Chassis' }, 'server'],
    // Firmware wins over a battery (e.g. a desktop reporting a UPS).
    [{ chassisType: 'Tower', batteryPresent: true }, 'desktop'],
    // Apple: marketing name, never the ambiguous "Mac14,x" identifier.
    [{ model: 'Mac14,2 MacBook Air (M2, 2022)' }, 'laptop'],
    [{ model: 'Mac14,3 Mac mini (2023)' }, 'desktop'],
    [{ model: 'Mac13,1 Mac Studio (2022)' }, 'desktop'],
    [{ model: 'iMac21,1 iMac (24-inch, M1, 2021)' }, 'all-in-one'],
    // Placeholder chassis ("Other") falls back to the battery.
    [{ chassisType: 'Other', batteryPresent: true }, 'laptop'],
    [{ chassisType: 'Other' }, 'unknown'],
    [{}, 'unknown'],
  ];
  for (const [input, want] of cases) assert.equal(ff(input), want, JSON.stringify(input));
  assert.equal(n.classifyFormFactor({ chassisType: 'Notebook' }).source, 'chassis');
  assert.equal(n.classifyFormFactor({ batteryPresent: true }).source, 'battery');
});

test('SMBIOS chassis codes from Linux sysfs', () => {
  assert.equal(n.chassisName('10\n'), 'Notebook');
  assert.equal(n.chassisName('3'), 'Desktop');
  assert.equal(n.chassisName('13'), 'All in One');
  assert.equal(n.chassisName('35'), 'Mini PC');
  assert.equal(n.chassisName(''), null);
  assert.equal(n.chassisName('99'), null);
});
