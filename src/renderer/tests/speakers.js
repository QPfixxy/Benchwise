import { el } from '../dom.js';
import { resultPanel, deviceSelect } from './common.js';

export default {
  id: 'speakers',
  name: 'Speakers',
  description:
    'Play each channel separately to confirm left and right both work, then run the sweep and the music sample at high volume to listen for rattle or distortion.',

  mount(root, ctx) {
    let sinkId = '';
    let sinkLabel = null;
    let audioCtx = null;
    let current = null; // { stop() }
    const played = new Set();
    const status = el('p', { class: 'muted' }, 'Turn the system volume up before starting.');
    const sample = new Audio('assets/sample.m4a');
    const panel = resultPanel(ctx, {
      getDetails: () => ({ device: sinkLabel, played: [...played] }),
    });

    async function getCtx() {
      if (!audioCtx) {
        audioCtx = new AudioContext();
      }
      if (sinkId && typeof audioCtx.setSinkId === 'function' && audioCtx.sinkId !== sinkId) {
        await audioCtx.setSinkId(sinkId).catch(() => {});
      }
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      return audioCtx;
    }

    function stopCurrent() {
      current?.stop();
      current = null;
      sample.pause();
      sample.currentTime = 0;
    }

    async function tone(label, pan, { freq = 440, sweep = false, seconds = 1.5 } = {}) {
      stopCurrent();
      const ac = await getCtx();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      const panner = ac.createStereoPanner();
      const t = ac.currentTime;
      osc.type = 'sine';
      if (sweep) {
        osc.frequency.setValueAtTime(60, t);
        osc.frequency.exponentialRampToValueAtTime(12000, t + seconds);
      } else {
        osc.frequency.value = freq;
      }
      panner.pan.value = pan;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.35, t + 0.05);
      gain.gain.setValueAtTime(0.35, t + seconds - 0.1);
      gain.gain.linearRampToValueAtTime(0, t + seconds);
      osc.connect(gain).connect(panner).connect(ac.destination);
      osc.start(t);
      osc.stop(t + seconds);
      played.add(label);
      status.textContent = `Playing: ${label}`;
      osc.onended = () => {
        if (current?.osc === osc) {
          current = null;
          status.textContent = 'Done. Did you hear it from the expected side?';
        }
      };
      current = { osc, stop: () => osc.stop() };
    }

    async function playSample() {
      stopCurrent();
      if (sinkId && typeof sample.setSinkId === 'function') await sample.setSinkId(sinkId).catch(() => {});
      sample.play().then(
        () => {
          played.add('music sample');
          status.textContent = 'Playing music sample…';
        },
        (err) => (status.textContent = `Could not play sample: ${err.message}`),
      );
    }

    const controls = el('div', { class: 'row' });
    root.append(
      controls,
      el(
        'div',
        { class: 'speaker-grid' },
        el('button', { class: 'btn big', onclick: () => tone('left', -1) }, '◀ Left'),
        el('button', { class: 'btn big', onclick: () => tone('both', 0) }, 'Both'),
        el('button', { class: 'btn big', onclick: () => tone('right', 1) }, 'Right ▶'),
        el('button', { class: 'btn', onclick: () => tone('sweep', 0, { sweep: true, seconds: 6 }) }, 'Frequency sweep (60 Hz → 12 kHz)'),
        el('button', { class: 'btn', onclick: playSample }, '♪ Music sample'),
        el('button', { class: 'btn ghost', onclick: () => (stopCurrent(), (status.textContent = 'Stopped.')) }, 'Stop'),
      ),
      status,
      panel.node,
    );

    (async () => {
      const { select, devices } = await deviceSelect('audiooutput', async (id, label) => {
        sinkId = id;
        sinkLabel = label;
        stopCurrent();
      });
      if (!devices.length) return;
      // Ranked list: default to the built-in speakers, not a headset/monitor.
      sinkId = devices[0].deviceId;
      sinkLabel = devices[0].label;
      controls.append(el('label', { class: 'field inline' }, el('span', {}, 'Output'), select));
    })();

    return () => {
      stopCurrent();
      audioCtx?.close().catch(() => {});
      panel.dispose();
    };
  },
};
