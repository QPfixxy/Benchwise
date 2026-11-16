import { el, fill, kvList, table } from '../dom.js';
import { describeDevice } from '../devices.js';
import { enabledTests } from '../app.js';

const FORM_LABELS = { laptop: 'Laptop', tablet: 'Tablet', 'all-in-one': 'All-in-one', desktop: 'Desktop', server: 'Server', unknown: 'Unknown' };
function unitType(sys) {
  const label = FORM_LABELS[sys.formFactor] || null;
  if (!label) return sys.chassisType || null;
  const why = sys.formFactorSource === 'battery' ? 'has a battery' : sys.formFactorSource === 'model' ? 'from model' : sys.chassisType ? `${sys.chassisType} chassis` : null;
  return why ? `${label} (${why})` : label;
}

const join = (...xs) => xs.filter(Boolean).join(' · ');

function card(title, ...body) {
  return el('section', { class: 'card' }, el('h2', {}, title), ...body);
}

function render(hw, media) {
  const sys = hw.system;
  const cpu = hw.cpu;
  const mem = hw.memory;
  const bat = hw.battery;
  const cores = join(
    cpu.physicalCores && `${cpu.physicalCores} cores`,
    cpu.threads && `${cpu.threads} threads`,
    cpu.performanceCores && cpu.efficiencyCores && `${cpu.performanceCores}P + ${cpu.efficiencyCores}E`,
  );

  return [
    hw.warnings?.length
      ? el('div', { class: 'warnings' }, hw.warnings.map((w) => el('p', {}, `⚠ ${w}`)))
      : null,
    el(
      'div',
      { class: 'cards' },
      card(
        'System',
        kvList([
          ['Manufacturer', sys.manufacturer, true],
          ['Model', sys.model, true],
          ['Serial', sys.serial ? el('code', {}, sys.serial) : null, true],
          ['Version / SKU', join(sys.version, sys.sku)],
          ['Unit type', unitType(sys)],
          ['BIOS', join(sys.bios?.vendor, sys.bios?.version, sys.bios?.releaseDate)],
          ['OS', join(sys.os?.distro, sys.os?.release, sys.os?.arch)],
          ['Virtual machine', sys.virtual ? 'Yes' : null],
        ]),
      ),
      card(
        'Processor',
        kvList([
          ['Model', cpu.name, true],
          ['Cores', cores],
          ['Base / Max', join(cpu.baseSpeed, cpu.maxSpeed)],
        ]),
      ),
      card(
        'Memory',
        kvList([
          ['Installed', mem.total, true],
          ['Slots', mem.slotsTotal ? `${mem.slotsUsed} of ${mem.slotsTotal} used` : null],
        ]),
        mem.slots.length
          ? table(
              ['Slot', 'Size', 'Type', 'Speed', 'Part #'],
              mem.slots.map((s) => (s.empty ? [s.slot, 'Empty', '', '', ''] : [s.slot, s.size, join(s.type, s.formFactor), s.speed, s.partNumber])),
            )
          : null,
      ),
      card(
        'Battery',
        bat.present
          ? kvList([
              [
                'Health',
                bat.healthPercent != null
                  ? el('span', { class: bat.healthPercent < 80 ? 'warn-text' : '' }, `${bat.healthPercent}%`)
                  : null,
                true,
              ],
              ['Cycle count', bat.cycleCount],
              ['Full / Design', [bat.fullChargeCapacity, bat.designedCapacity].filter(Boolean).join(' / ')],
              ['Charge', bat.chargePercent != null ? `${bat.chargePercent}%${bat.charging ? ' (charging)' : ''}` : null],
              ['Model', join(bat.manufacturer, bat.model)],
            ])
          : el('p', { class: 'muted' }, 'No battery detected'),
      ),
      card(
        'Storage',
        table(
          ['Model', 'Capacity', 'Type', 'Serial', 'SMART'],
          hw.storage.map((d) => [
            d.model,
            d.capacity,
            d.kind,
            d.serial,
            el('span', { class: d.smartStatus === 'FAILING' ? 'fail-text' : d.smartStatus === 'OK' ? 'pass-text' : 'muted' }, d.smartStatus),
          ]),
          { empty: 'No drives detected (a wiped/absent drive is expected on some units).' },
        ),
      ),
      card(
        'Graphics & Display',
        table(
          ['Type', 'Model', 'VRAM'],
          hw.graphics.gpus.map((g) => [g.kind === 'discrete' ? 'Dedicated' : 'Integrated', g.model, g.vram]),
        ),
        hw.graphics.displays.length
          ? table(
              ['Display', 'Resolution', 'Refresh', 'Size'],
              hw.graphics.displays.map((d) => [
                d.builtin ? 'Built-in' : d.model || d.connection || 'External',
                d.resolution,
                d.refreshRate,
                d.sizeInches ? `${d.sizeInches}"` : null,
              ]),
            )
          : null,
      ),
      card(
        'Network',
        table(['Type', 'Interface', 'MAC'], hw.network.map((n) => [n.type, n.name, el('code', {}, n.mac)])),
      ),
      card(
        'Audio / Video',
        kvList([
          ['Cameras', media.cameras.map((d) => describeDevice(d.label)).join(', ') || 'None detected', true],
          ['Microphones', media.microphones.map((d) => describeDevice(d.label)).join(', ') || 'None detected', true],
          ['Speakers', media.speakers.map((d) => describeDevice(d.label)).join(', ') || 'None detected', true],
        ]),
      ),
    ),
    el('p', { class: 'muted small' }, `Collected ${new Date(hw.collectedAt).toLocaleTimeString()} in ${(hw.durationMs / 1000).toFixed(1)}s`),
  ];
}

export default {
  mount(root, ctx) {
    const body = el('div', {});
    const head = el(
      'div',
      { class: 'page-head' },
      el('div', {}, el('h1', {}, 'System Overview'), el('p', { class: 'muted' }, 'Hardware detected on this unit. Verify it matches the physical machine.')),
      el(
        'div',
        { class: 'row' },
        el('button', { class: 'btn ghost', onclick: () => ctx.scanHardware(true) }, '↻ Rescan'),
        el(
          'button',
          {
            class: 'btn primary',
            onclick: () => {
              const first = enabledTests()[0];
              ctx.navigate(first ? `test:${first.id}` : 'finish');
            },
          },
          'Start tests →',
        ),
      ),
    );

    let last = [];
    const draw = (s) => {
      // Skip unrelated updates (e.g. stress progress every second).
      const deps = [s.scanning, s.hardware, s.hardwareError, s.media];
      if (deps.every((d, i) => d === last[i])) return;
      last = deps;
      if (s.scanning && !s.hardware) {
        fill(body, el('div', { class: 'loading' }, el('span', { class: 'spinner' }), 'Scanning hardware… this can take 10–20 seconds on Windows.'));
      } else if (s.hardwareError) {
        fill(body, el('div', { class: 'warnings' }, el('p', {}, `Hardware scan failed: ${s.hardwareError}`)));
      } else if (s.hardware) {
        fill(body, ...render(s.hardware, s.media).filter(Boolean));
      }
    };
    draw(ctx.state);
    const off = ctx.onChange(draw);
    root.append(head, body);
    return off;
  },
};
