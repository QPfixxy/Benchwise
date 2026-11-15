import { el } from '../dom.js';
import { resultPanel, stopStream, deviceSelect } from './common.js';

const RECORD_SECONDS = 5;
const SILENCE_PEAK = 0.02; // below this the mic is effectively dead

export default {
  id: 'microphone',
  name: 'Microphone',
  description: `Record ${RECORD_SECONDS} seconds of speech, watch the level meter respond, then play it back and listen for clarity.`,

  mount(root, ctx) {
    let deviceId = null;
    let deviceLabel = null;
    let stream = null;
    let audioCtx = null;
    let recorder = null;
    let raf = 0;
    let timer = 0;
    let peak = 0;
    let disposed = false;
    let playbackUrl = null;

    const meterFill = el('div', { class: 'meter-fill' });
    const peakMark = el('div', { class: 'meter-peak' });
    const meter = el('div', { class: 'meter' }, meterFill, peakMark);
    const status = el('p', { class: 'muted' }, 'Press Record and speak normally.');
    const audio = el('audio', { controls: true, class: 'playback hidden' });
    const recordBtn = el('button', { class: 'btn primary', onclick: () => (recorder ? stop() : record()) }, '● Record');
    const controls = el('div', { class: 'row' });
    const panel = resultPanel(ctx, {
      getDetails: () => ({ device: deviceLabel, peakLevel: `${Math.round(peak * 100)}%` }),
    });

    function release() {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      stopStream(stream); // releases the mic (the original left it open)
      stream = null;
      audioCtx?.close().catch(() => {});
      audioCtx = null;
    }

    async function record() {
      peak = 0;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          // Raw signal: OS noise suppression would hide a crackling mic.
          audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
      } catch (err) {
        status.textContent = `Could not open microphone: ${err.message}`;
        return;
      }
      if (disposed) return release();
      deviceLabel = stream.getAudioTracks()[0]?.label || deviceLabel;
      audioCtx = new AudioContext();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);

      const chunks = [];
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = () => {
        if (playbackUrl) URL.revokeObjectURL(playbackUrl);
        playbackUrl = URL.createObjectURL(new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' }));
        audio.src = playbackUrl;
        audio.classList.remove('hidden');
        recorder = null;
        release();
        recordBtn.textContent = '● Record again';
        meterFill.style.width = '0%';
        status.textContent =
          peak < SILENCE_PEAK
            ? `No signal detected (peak ${Math.round(peak * 100)}%). The microphone may be dead, muted, or disabled in the OS.`
            : `Recorded. Peak level ${Math.round(peak * 100)}%. Play it back and listen for clarity.`;
        if (!disposed) audio.play().catch(() => {});
      };
      recorder.start();
      recordBtn.textContent = '■ Stop';

      const started = performance.now();
      const tick = () => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        let p = 0;
        for (const v of buf) {
          sum += v * v;
          p = Math.max(p, Math.abs(v));
        }
        const rms = Math.sqrt(sum / buf.length);
        peak = Math.max(peak, p);
        meterFill.style.width = `${Math.min(100, rms * 400)}%`;
        meterFill.classList.toggle('clip', p > 0.98);
        peakMark.style.left = `${Math.min(100, peak * 100)}%`;
        const left = Math.max(0, RECORD_SECONDS - (performance.now() - started) / 1000);
        status.textContent = `Recording… ${left.toFixed(1)}s`;
        raf = requestAnimationFrame(tick);
      };
      tick();
      timer = setTimeout(stop, RECORD_SECONDS * 1000);
    }

    function stop() {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      if (recorder?.state === 'recording') recorder.stop();
    }

    (async () => {
      const { select, devices } = await deviceSelect('audioinput', (id, label) => {
        deviceId = id;
        deviceLabel = label;
      });
      if (disposed) return;
      if (!devices.length) {
        status.textContent = 'No microphone detected.';
        recordBtn.disabled = true;
        return;
      }
      deviceId = devices[0].deviceId;
      deviceLabel = devices[0].label;
      controls.prepend(el('label', { class: 'field inline' }, el('span', {}, 'Microphone'), select));
    })();

    controls.append(recordBtn);
    root.append(controls, meter, status, audio, panel.node);
    return () => {
      disposed = true;
      if (recorder?.state === 'recording') {
        recorder.onstop = null;
        recorder.stop();
      }
      release();
      audio.pause();
      if (playbackUrl) URL.revokeObjectURL(playbackUrl);
      panel.dispose();
    };
  },
};
