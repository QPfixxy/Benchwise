'use strict';

// Pure functions that turn raw `systeminformation` output into the report
// schema. No I/O here, so everything in this file is unit-tested.

const GB = 1e9; // storage is sold in decimal units
const GiB = 1024 ** 3; // memory is sold in binary units

// Placeholder strings OEMs and board vendors leave in DMI/SMBIOS fields.
const JUNK_VALUE_PATTERNS = [
  /to be filled/i,
  /default string/i,
  /system serial number/i,
  /system product name/i,
  /system manufacturer/i,
  /not specified/i,
  /not applicable/i,
  /not available/i,
  /^n\/?a$/i,
  /^none$/i,
  /^unknown$/i,
  /o\.?e\.?m\.?/i,
  /^chassis serial number$/i,
  /^base board serial number$/i,
  /^123456789$/,
  /^0123456789$/,
];

function clean(value) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

/** True when a DMI string is empty or an obvious placeholder. */
function isJunkValue(value) {
  const v = clean(value);
  if (!v) return true;
  if (/^(.)\1*$/.test(v)) return true; // "0000000", "XXXXXX", "......"
  return JUNK_VALUE_PATTERNS.some((re) => re.test(v));
}

/** Returns the cleaned value, or null when it is a placeholder. */
function realValue(value) {
  return isJunkValue(value) ? null : clean(value);
}

/** First non-placeholder serial, with where it came from. */
function pickSerial(candidates) {
  for (const [source, value] of candidates) {
    const v = realValue(value);
    if (v) return { value: v, source };
  }
  return { value: null, source: null };
}

function round(n, digits = 0) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** Storage capacity as marketed: 512110190592 -> "512 GB", 2000398934016 -> "2 TB". */
function formatStorage(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  const gb = bytes / GB;
  if (gb >= 1000) return `${round(gb / 1000, 1)} TB`;
  if (gb >= 10) return `${Math.round(gb)} GB`;
  return `${round(gb, 1)} GB`;
}

/** Memory capacity in binary units, labelled GB the way RAM is sold. */
function formatMemory(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  const gib = bytes / GiB;
  return gib >= 1 ? `${round(gib, gib >= 10 ? 0 : 1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** VRAM from systeminformation is in MB. */
function formatVram(mb) {
  if (!Number.isFinite(mb) || mb <= 0) return null;
  return mb >= 1024 ? `${round(mb / 1024, 1)} GB` : `${mb} MB`;
}

function formatGhz(ghz) {
  return Number.isFinite(ghz) && ghz > 0 ? `${ghz.toFixed(2)} GHz` : null;
}

// ---------------------------------------------------------------- system

function normalizeSystem({ system = {}, chassis = {}, baseboard = {}, bios = {}, osInfo = {} }) {
  const serial = pickSerial([
    ['system', system.serial],
    ['chassis', chassis.serial],
    ['baseboard', baseboard.serial],
  ]);
  return {
    manufacturer: realValue(system.manufacturer) || realValue(baseboard.manufacturer),
    model: realValue(system.model) || realValue(baseboard.model),
    version: realValue(system.version),
    sku: realValue(system.sku),
    serial: serial.value,
    serialSource: serial.source,
    uuid: realValue(system.uuid),
    chassisType: realValue(chassis.type),
    virtual: Boolean(system.virtual),
    baseboard: {
      manufacturer: realValue(baseboard.manufacturer),
      model: realValue(baseboard.model),
      serial: realValue(baseboard.serial),
    },
    bios: {
      vendor: realValue(bios.vendor),
      version: realValue(bios.version),
      releaseDate: realValue(bios.releaseDate),
    },
    os: {
      platform: osInfo.platform || null,
      distro: realValue(osInfo.distro),
      release: realValue(osInfo.release),
      arch: osInfo.arch || null,
      hostname: osInfo.hostname || null,
    },
  };
}

// ------------------------------------------------------------- form factor

// SMBIOS (DMTF DSP0134) chassis type codes, for /sys/class/dmi/id/chassis_type.
const SMBIOS_CHASSIS = {
  1: 'Other', 2: 'Unknown', 3: 'Desktop', 4: 'Low Profile Desktop', 5: 'Pizza Box', 6: 'Mini Tower', 7: 'Tower',
  8: 'Portable', 9: 'Laptop', 10: 'Notebook', 11: 'Hand Held', 12: 'Docking Station', 13: 'All in One',
  14: 'Sub Notebook', 15: 'Space-saving', 16: 'Lunch Box', 17: 'Main Server Chassis', 18: 'Expansion Chassis',
  19: 'SubChassis', 20: 'Bus Expansion Chassis', 21: 'Peripheral Chassis', 22: 'RAID Chassis', 23: 'Rack Mount Chassis',
  24: 'Sealed-case PC', 25: 'Multi-system chassis', 26: 'Compact PCI', 27: 'Advanced TCA', 28: 'Blade',
  29: 'Blade Enclosure', 30: 'Tablet', 31: 'Convertible', 32: 'Detachable', 33: 'IoT Gateway', 34: 'Embedded PC',
  35: 'Mini PC', 36: 'Stick PC',
};

function chassisName(code) {
  return SMBIOS_CHASSIS[Number(String(code).trim())] || null;
}

const FORM_FACTOR_RULES = [
  ['tablet', /^tablet$|hand ?held/i],
  ['laptop', /laptop|notebook|portable|convertible|detachable/i],
  ['all-in-one', /all[- ]?in[- ]?one/i],
  ['server', /server|rack|blade|multi-system|raid|expansion|compact pci|advanced tca/i],
  ['desktop', /desktop|tower|pizza|lunch ?box|space-saving|sealed-case|mini pc|stick pc|embedded|iot/i],
];

/**
 * What kind of unit this is, which decides whether the screen and keyboard
 * are part of it (laptop, tablet, all-in-one) or peripherals (desktop, server).
 * Order of trust: firmware chassis type, then Apple model name, then battery.
 * @returns {{ formFactor: 'laptop'|'tablet'|'all-in-one'|'desktop'|'server'|'unknown', source: string|null }}
 */
function classifyFormFactor({ chassisType, model, batteryPresent } = {}) {
  for (const [formFactor, re] of FORM_FACTOR_RULES) {
    if (re.test(chassisType || '')) return { formFactor, source: 'chassis' };
  }
  const m = model || '';
  if (/macbook/i.test(m)) return { formFactor: 'laptop', source: 'model' };
  if (/imac/i.test(m)) return { formFactor: 'all-in-one', source: 'model' };
  if (/mac ?mini|macmini|mac ?studio|mac ?pro\b|macpro/i.test(m)) return { formFactor: 'desktop', source: 'model' };
  if (batteryPresent) return { formFactor: 'laptop', source: 'battery' };
  return { formFactor: 'unknown', source: null };
}

// ---------------------------------------------------------------- cpu

function normalizeCpu(cpu = {}) {
  const manufacturer = clean(cpu.manufacturer);
  const brand = clean(cpu.brand);
  const name = brand.toLowerCase().startsWith(manufacturer.toLowerCase())
    ? brand
    : clean(`${manufacturer} ${brand}`);
  return {
    name: name || null,
    manufacturer: manufacturer || null,
    physicalCores: cpu.physicalCores || null,
    performanceCores: cpu.performanceCores || null,
    efficiencyCores: cpu.efficiencyCores || null,
    threads: cpu.cores || null,
    baseSpeed: formatGhz(cpu.speed),
    maxSpeed: formatGhz(cpu.speedMax),
    sockets: cpu.processors || null,
    virtualization: cpu.virtualization ?? null,
  };
}

// ---------------------------------------------------------------- memory

function normalizeMemory(mem = {}, layout = []) {
  const slots = (layout || []).map((m, i) => {
    const empty = !m.size;
    return {
      slot: realValue(m.bank) || `Slot ${i + 1}`,
      empty,
      size: empty ? null : formatMemory(m.size),
      sizeBytes: m.size || 0,
      type: realValue(m.type),
      speed: m.clockSpeed ? `${m.clockSpeed} MT/s` : null,
      formFactor: realValue(m.formFactor),
      manufacturer: realValue(m.manufacturer),
      partNumber: realValue(m.partNum),
      serial: realValue(m.serialNum),
      ecc: m.ecc === true ? true : m.ecc === false ? false : null,
    };
  });
  const installedBytes = slots.reduce((sum, s) => sum + s.sizeBytes, 0);
  // Prefer the sum of modules: mem.total is usable memory, which is lower
  // than installed memory once firmware and integrated graphics reserve some.
  const totalBytes = installedBytes > 0 ? installedBytes : mem.total || 0;
  return {
    total: formatMemory(totalBytes),
    totalBytes,
    totalSource: installedBytes > 0 ? 'modules' : 'os',
    slotsTotal: slots.length || null,
    slotsUsed: slots.length ? slots.filter((s) => !s.empty).length : null,
    slots,
  };
}

// ---------------------------------------------------------------- graphics

const VIRTUAL_GPU = /microsoft basic|remote display|parsec|citrix|vmware|virtualbox|hyper-v|qxl|virtio|llvmpipe|spice|rdp|indirect display|displaylink/i;

/** 'integrated' | 'discrete' | 'virtual' */
function classifyGpu(c = {}) {
  const vendor = clean(c.vendor).toLowerCase();
  const model = clean(c.model);
  const bus = clean(c.bus).toLowerCase();

  if (VIRTUAL_GPU.test(`${vendor} ${model}`)) return 'virtual';
  if (vendor.includes('apple') || /apple m\d/i.test(model)) return 'integrated';
  if (vendor.includes('nvidia')) return 'discrete';
  if (c.vramDynamic === true) return 'integrated';
  if (bus === 'onboard' || bus === 'built-in') return 'integrated';

  if (vendor.includes('intel')) {
    // Arc A/B-series cards are discrete; "Intel Arc Graphics" in Core Ultra is not.
    return /\barc\b.*\b[ab]\d{3}/i.test(model) ? 'discrete' : 'integrated';
  }
  if (vendor.includes('amd') || vendor.includes('ati') || vendor.includes('advanced micro')) {
    if (/\b(rx|r[579])\s?\d{3,4}|radeon pro|firepro|instinct|\bw\d{4}\b/i.test(model)) {
      return /\d{3}m\b/i.test(model) ? 'integrated' : 'discrete'; // e.g. "Radeon 780M" is an iGPU
    }
    return 'integrated'; // "AMD Radeon(TM) Graphics", "Radeon Vega 8", APUs
  }
  return Number(c.vram) >= 2048 ? 'discrete' : 'integrated';
}

function normalizeGraphics(graphics = {}) {
  const gpus = (graphics.controllers || []).map((c) => {
    const kind = classifyGpu(c);
    return {
      kind,
      vendor: realValue(c.vendor),
      model: realValue(c.model),
      vram: kind === 'discrete' && !c.vramDynamic ? formatVram(c.vram) : null,
      driver: realValue(c.driverVersion),
      bus: realValue(c.bus),
    };
  });
  const displays = (graphics.displays || []).map((d) => ({
    model: realValue(d.model),
    builtin: Boolean(d.builtin),
    main: Boolean(d.main),
    connection: realValue(d.connection),
    resolution:
      d.resolutionX && d.resolutionY
        ? `${d.resolutionX}×${d.resolutionY}`
        : d.currentResX && d.currentResY
          ? `${d.currentResX}×${d.currentResY}`
          : null,
    refreshRate: d.currentRefreshRate ? `${d.currentRefreshRate} Hz` : null,
    sizeInches:
      d.sizeX && d.sizeY ? round(Math.hypot(d.sizeX, d.sizeY) / 25.4, 1) : null,
  }));
  return { gpus: gpus.filter((g) => g.kind !== 'virtual'), virtualGpus: gpus.filter((g) => g.kind === 'virtual'), displays };
}

// ---------------------------------------------------------------- storage

const VIRTUAL_DISK = /virtual|disk image|vhd|msft|ramdisk|qemu|vbox|apfs container|synthetic/i;

function storageKind(d) {
  const iface = clean(d.interfaceType).toLowerCase();
  const type = clean(d.type).toLowerCase();
  if (iface.includes('nvme') || type === 'nvme') return 'NVMe SSD';
  if (type === 'ssd') return 'SSD';
  if (type === 'hd' || type === 'hdd') return 'HDD';
  if (iface === 'usb') return 'USB';
  return type ? clean(d.type) : null;
}

function normalizeDisks(disks = []) {
  return (disks || [])
    .filter((d) => d.size > 0 && !VIRTUAL_DISK.test(`${d.name} ${d.vendor} ${d.type}`))
    .map((d) => ({
      model: realValue(d.name) || realValue(d.vendor),
      vendor: realValue(d.vendor),
      serial: realValue(d.serialNum),
      capacity: formatStorage(d.size),
      sizeBytes: d.size,
      kind: storageKind(d),
      interface: realValue(d.interfaceType),
      firmware: realValue(d.firmwareRevision),
      removable: clean(d.interfaceType).toLowerCase() === 'usb',
      smartStatus: normalizeSmart(d.smartStatus),
      powerOnHours: d.smartData?.power_on_time?.hours ?? null,
      temperatureC: d.temperature ?? d.smartData?.temperature?.current ?? null,
    }));
}

function normalizeSmart(status) {
  const s = clean(status).toLowerCase();
  if (s === 'ok') return 'OK';
  if (s.includes('predicted') || s.includes('fail')) return 'FAILING';
  return 'Unknown';
}

// ---------------------------------------------------------------- battery

function normalizeBattery(b = {}) {
  if (!b || !b.hasBattery) return { present: false };
  const designed = Number(b.designedCapacity) || 0;
  const max = Number(b.maxCapacity) || 0;
  // Health is full-charge capacity vs. design capacity. The original code used
  // currentCapacity, which is the present charge, not wear.
  const health = designed > 0 && max > 0 ? round(Math.min((max / designed) * 100, 100), 1) : null;
  const unit = b.capacityUnit || 'mWh';
  return {
    present: true,
    healthPercent: health,
    cycleCount: Number.isFinite(b.cycleCount) && b.cycleCount > 0 ? b.cycleCount : null,
    chargePercent: Number.isFinite(b.percent) ? b.percent : null,
    charging: Boolean(b.isCharging),
    acConnected: Boolean(b.acConnected),
    designedCapacity: designed ? `${designed} ${unit}` : null,
    fullChargeCapacity: max ? `${max} ${unit}` : null,
    voltage: Number.isFinite(b.voltage) && b.voltage > 0 ? `${round(b.voltage, 2)} V` : null,
    manufacturer: realValue(b.manufacturer),
    model: realValue(b.model),
    serial: realValue(b.serial),
    chemistry: realValue(b.type),
  };
}

// ---------------------------------------------------------------- network

/** Locally-administered MACs (bit 0x02 of the first octet) are virtual or randomized, never burned in. */
function isLocalMac(mac) {
  return (parseInt(String(mac).slice(0, 2), 16) & 0x02) !== 0;
}

function normalizeNetwork(ifaces = [], { hardwareOnly = false } = {}) {
  const list = Array.isArray(ifaces) ? ifaces : [ifaces];
  return list
    .filter(
      (n) =>
        n &&
        !n.internal &&
        !n.virtual &&
        n.mac &&
        !/^(00:){5}00$/.test(n.mac) &&
        n.mac !== '02:00:00:00:00:00' && // macOS privacy placeholder
        !(hardwareOnly && isLocalMac(n.mac)) &&
        !/^(bridge|docker|veth|vmnet|vboxnet|utun|awdl|llw|tun|tap|lo|anpi|nan|ap\d)/i.test(n.iface || ''),
    )
    .map((n) => ({
      name: realValue(n.ifaceName) || n.iface,
      type: n.type === 'wireless' ? 'Wi-Fi' : n.type === 'wired' ? 'Ethernet' : realValue(n.type),
      mac: n.mac.toUpperCase(),
      speed: n.speed ? `${n.speed} Mb/s` : null,
    }));
}

/**
 * Parses Windows `Get-NetAdapter -Physical` lines:
 * Name|InterfaceDescription|MacAddress|PhysicalMediaType|ReceiveLinkSpeed(bits/s)
 */
function parseWindowsNetAdapters(text = '') {
  return String(text)
    .split(/\r?\n/)
    .map((l) => l.trim().split('|'))
    .filter((p) => p.length >= 5 && /^([0-9a-f]{2}-){5}[0-9a-f]{2}$/i.test(p[2].trim()))
    .map(([name, desc, mac, media, speed]) => {
      const bps = Number(speed);
      return {
        iface: name.trim(),
        ifaceName: `${name.trim()}${desc.trim() ? ` (${desc.trim()})` : ''}`,
        mac: mac.trim().replace(/-/g, ':'),
        type: /802\.11|wireless|wi-?fi/i.test(media) ? 'wireless' : /802\.3/.test(media) ? 'wired' : media.trim() || null,
        speed: bps > 0 ? Math.round(bps / 1e6) : null,
      };
    });
}

/** Parses `networksetup -listallhardwareports` (macOS), which reports burned-in MACs. */
function parseMacHardwarePorts(text = '') {
  return String(text)
    .split(/\n\s*\n/)
    .map((block) => ({
      port: (block.match(/Hardware Port:\s*(.+)/) || [])[1]?.trim(),
      iface: (block.match(/Device:\s*(\S+)/) || [])[1],
      mac: (block.match(/Ethernet Address:\s*([0-9a-f:]{17})/i) || [])[1],
    }))
    .filter((p) => p.port && p.iface && p.mac)
    .map((p) => ({ iface: p.iface, ifaceName: p.port, mac: p.mac, type: /wi-?fi|airport/i.test(p.port) ? 'wireless' : 'wired' }));
}

// ---------------------------------------------------------------- usb

function normalizeUsb(devices = []) {
  return (devices || [])
    .filter((d) => d && !/hub|root/i.test(`${d.type} ${d.name}`))
    .map((d) => ({
      id: [d.bus, d.deviceId, d.vendorId, d.productId, d.serialNumber].filter((x) => x != null).join(':') || d.name,
      name: realValue(d.name) || 'Unknown device',
      type: realValue(d.type),
      manufacturer: realValue(d.manufacturer) || realValue(d.vendor),
      serial: realValue(d.serialNumber),
      removable: d.removable ?? null,
    }));
}

// ---------------------------------------------------------------- audits

const TEST_STATUSES = ['pass', 'fail', 'na', 'untested'];

/** 'fail' if anything failed, 'incomplete' if anything is untested, else 'pass'. */
function overallStatus(tests = {}) {
  const statuses = Object.values(tests).map((t) => t?.status || 'untested');
  if (statuses.includes('fail')) return 'fail';
  if (statuses.length === 0 || statuses.includes('untested')) return 'incomplete';
  return 'pass';
}

const SAFE_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Validates an asset tag against the shop's configured pattern and a fixed
 * filename-safe character set (enforced in the main process, never only in UI).
 */
function validateAssetTag(tag, pattern) {
  const v = clean(tag);
  if (!v) return { ok: false, error: 'Asset tag is required.' };
  if (!SAFE_TAG.test(v)) {
    return { ok: false, error: 'Use letters, digits, dot, dash or underscore (max 64).' };
  }
  if (pattern) {
    let re;
    try {
      re = new RegExp(`^(?:${pattern})$`);
    } catch {
      return { ok: false, error: 'The asset tag pattern in Settings is not a valid regular expression.' };
    }
    if (!re.test(v)) return { ok: false, error: `Asset tag must match the format ${pattern}.` };
  }
  return { ok: true, value: v };
}

module.exports = {
  isJunkValue,
  realValue,
  pickSerial,
  formatStorage,
  formatMemory,
  formatVram,
  normalizeSystem,
  normalizeCpu,
  normalizeMemory,
  classifyGpu,
  normalizeGraphics,
  normalizeDisks,
  normalizeBattery,
  normalizeNetwork,
  parseMacHardwarePorts,
  parseWindowsNetAdapters,
  classifyFormFactor,
  chassisName,
  normalizeUsb,
  overallStatus,
  validateAssetTag,
  TEST_STATUSES,
};
