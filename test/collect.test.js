'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { runProbes, runProbesBatched, linuxNics, windowsNics } = require('../src/main/hardware/collect');
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

/**
 * Fake batch worker: runs `behaviour[name]` for each probe in order, posting
 * start/result/done like probe-worker.js. 'hang' never answers; 'crash' exits.
 */
function fakeBatch(behaviour, log) {
  return (names) => {
    log.push([...names]);
    const w = new EventEmitter();
    let stopped = false;
    w.terminate = () => {
      stopped = true;
      return Promise.resolve();
    };
    (async () => {
      for (const name of names) {
        await sleep(1);
        if (stopped) return;
        w.emit('message', { type: 'start', name });
        const b = behaviour[name];
        if (b === 'hang') return; // never answers
        if (b === 'crash') return w.emit('exit', 3);
        await sleep(2);
        if (stopped) return;
        w.emit('message', b === 'error' ? { type: 'result', name, ok: false, error: 'boom' } : { type: 'result', name, ok: true, value: { from: name } });
      }
      if (!stopped) w.emit('message', { type: 'done' });
    })();
    return w;
  };
}

test('batched probes: one worker for everything when nothing goes wrong', async () => {
  const log = [];
  const res = await runProbesBatched([['system', {}], ['cpu', {}], ['usb', []]], { createWorker: fakeBatch({}, log), tickMs: 5 });
  assert.equal(log.length, 1, 'a single worker (one PowerShell) for all probes');
  assert.deepEqual(res.raw, { system: { from: 'system' }, cpu: { from: 'cpu' }, usb: { from: 'usb' } });
  assert.deepEqual(res.warnings, []);
  assert.ok(Object.values(res.timings).every((t) => t.ok));
});

test('batched probes: a hung probe times out alone and the rest continue in a new worker', async () => {
  const log = [];
  const res = await runProbesBatched([['system', {}], ['cpu', {}], ['disks', []], ['usb', []]], {
    createWorker: fakeBatch({ cpu: 'hang', usb: 'error' }, log),
    timeoutMs: 40,
    tickMs: 5,
  });
  assert.deepEqual(log, [['system', 'cpu', 'disks', 'usb'], ['disks', 'usb']]);
  assert.deepEqual(res.raw.system, { from: 'system' });
  assert.deepEqual(res.raw.cpu, {}, 'fallback value');
  assert.deepEqual(res.raw.disks, { from: 'disks' });
  assert.deepEqual(res.raw.usb, [], 'an error also gets the fallback');
  assert.deepEqual(res.warnings, ['cpu: timed out after 0.04s', 'usb: boom']);
  assert.equal(res.timings.cpu.ok, false);
});

test('batched probes: a crashed worker loses only the probe it was on', async () => {
  const log = [];
  const res = await runProbesBatched([['system', {}], ['graphics', {}], ['usb', []]], { createWorker: fakeBatch({ graphics: 'crash' }, log), tickMs: 5 });
  assert.deepEqual(log, [['system', 'graphics', 'usb'], ['usb']]);
  assert.deepEqual(res.raw.usb, { from: 'usb' });
  assert.match(res.warnings[0], /^graphics: probe stopped unexpectedly/);
});

const GETMAC = [
  '"Ethernet","Intel(R) Ethernet Connection (11) I219-LM","90-2E-16-00-00-01","\\Device\\Tcpip_{1234}"',
  '"Wi-Fi","Intel(R) Wi-Fi 6 AX201 160MHz","F4-4E-E3-00-00-02","Media disconnected"',
  '"Bluetooth Network Connection","Bluetooth Device (Personal Area Network)","F4-4E-E3-00-00-03","Media disconnected"',
  '"vEthernet (Default Switch)","Hyper-V Virtual Ethernet Adapter","00-15-5D-00-00-04","\\Device\\Tcpip_{5678}"',
  '"Ethernet 2","Some Adapter","N/A","Disabled"',
].join('\r\n');

test('getmac parsing: real adapters only, wireless detected, MACs with colons', () => {
  assert.deepEqual(n.parseGetmac(GETMAC), [
    { iface: 'Ethernet', ifaceName: 'Ethernet (Intel(R) Ethernet Connection (11) I219-LM)', mac: '90:2E:16:00:00:01', type: 'wired', speed: null },
    { iface: 'Wi-Fi', ifaceName: 'Wi-Fi (Intel(R) Wi-Fi 6 AX201 160MHz)', mac: 'F4:4E:E3:00:00:02', type: 'wireless', speed: null },
  ]);
});

test('Windows NICs: Get-NetAdapter preferred, getmac fills in when PowerShell is slow or empty', async () => {
  const netAdapter = 'Ethernet|Intel(R) Ethernet Connection (11) I219-LM|90-2E-16-00-00-01|802.3|1000000000';
  const both = await windowsNics({ exec: async (cmd) => (cmd === 'getmac' ? GETMAC : netAdapter) });
  assert.deepEqual(both.map((a) => [a.iface, a.speed]), [['Ethernet', 1000], ['Wi-Fi', null]]);
  const slowPs = await windowsNics({ exec: async (cmd) => (cmd === 'getmac' ? GETMAC : '') }); // run() gives '' on timeout
  assert.deepEqual(slowPs.map((a) => a.iface), ['Ethernet', 'Wi-Fi']);
});
