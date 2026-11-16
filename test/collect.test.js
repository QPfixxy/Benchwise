'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runProbes, linuxNics } = require('../src/main/hardware/collect');
const n = require('../src/main/hardware/normalize');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a slow or failing probe only loses its own section, with timings recorded', async () => {
  const run = async (key) => {
    if (key === 'network') throw new Error('timed out after 25s');
    if (key === 'usb') throw new Error('boom');
    await sleep(5);
    return { from: key };
  };
  const { raw, warnings, timings } = await runProbes(
    [['system', {}], ['network', []], ['usb', []], ['cpu', {}]],
    { run, concurrency: 2 },
  );
  assert.deepEqual(raw.system, { from: 'system' });
  assert.deepEqual(raw.cpu, { from: 'cpu' });
  assert.deepEqual(raw.network, []); // fallback
  assert.deepEqual(raw.usb, []);
  assert.deepEqual(warnings.sort(), ['network: timed out after 25s', 'usb: boom']);
  assert.equal(timings.system.ok, true);
  assert.equal(timings.network.ok, false);
  assert.ok(timings.cpu.ms >= 0);
});

test('probe pool never runs more than the concurrency limit at once', async () => {
  let active = 0;
  let peak = 0;
  const run = async () => {
    peak = Math.max(peak, ++active);
    await sleep(10);
    active--;
    return {};
  };
  const list = Array.from({ length: 10 }, (_, i) => [`p${i}`, {}]);
  const { raw } = await runProbes(list, { run, concurrency: 3 });
  assert.equal(peak, 3);
  assert.equal(Object.keys(raw).length, 10);
});

test('Linux NICs come from sysfs: physical only, unplugged ports included', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchwise-net-'));
  const nic = (name, { mac, device = true, wireless = false, speed }) => {
    const d = path.join(root, name);
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'address'), `${mac}\n`);
    if (device) fs.mkdirSync(path.join(d, 'device'));
    if (wireless) fs.mkdirSync(path.join(d, 'wireless'));
    if (speed !== undefined) fs.writeFileSync(path.join(d, 'speed'), `${speed}\n`);
  };
  nic('enp0s31f6', { mac: '3c:52:82:00:00:01', speed: -1 }); // cable unplugged
  nic('wlp2s0', { mac: '3c:52:82:00:00:02', wireless: true });
  nic('lo', { mac: '00:00:00:00:00:00', device: false });
  nic('docker0', { mac: '02:42:ac:11:00:02', device: false });

  const nets = n.normalizeNetwork(await linuxNics(root));
  assert.deepEqual(
    nets.map((x) => [x.name, x.type, x.mac, x.speed]).sort(),
    [
      ['enp0s31f6', 'Ethernet', '3C:52:82:00:00:01', null],
      ['wlp2s0', 'Wi-Fi', '3C:52:82:00:00:02', null],
    ],
  );
});

test('Windows Get-NetAdapter output is parsed, disconnected adapters kept', () => {
  const text = [
    'Ethernet|Intel(R) Ethernet Connection (4) I219-LM|3C-52-82-00-00-01|802.3|0',
    'Wi-Fi|Intel(R) Wi-Fi 6 AX201 160MHz|3C-52-82-00-00-02|Native 802.11|866700000',
    'Bluetooth Network Connection|Bluetooth Device (Personal Area Network)|3C-52-82-00-00-03|BlueTooth|3000000',
    '',
    'garbage line',
  ].join('\r\n');
  const nets = n.normalizeNetwork(n.parseWindowsNetAdapters(text));
  assert.deepEqual(
    nets.map((x) => [x.type, x.mac, x.speed]),
    [
      ['Ethernet', '3C:52:82:00:00:01', null],
      ['Wi-Fi', '3C:52:82:00:00:02', '867 Mb/s'],
      ['BlueTooth', '3C:52:82:00:00:03', '3 Mb/s'],
    ],
  );
  assert.equal(nets[0].name, 'Ethernet (Intel(R) Ethernet Connection (4) I219-LM)');
});
