import { el } from '../dom.js';
import { resultPanel, stopStream, deviceSelect } from './common.js';

export default {
  id: 'camera',
  name: 'Camera',
  description: 'Check the image is clear, correctly oriented, and free of dead or stuck pixels. Cover the lens to confirm it responds.',

  mount(root, ctx) {
    let stream = null;
    let disposed = false;
    let details = {};
    const video = el('video', { class: 'camera-video', autoplay: true, playsinline: true, muted: true });
    const info = el('p', { class: 'muted' }, 'Starting camera…');
    const controls = el('div', { class: 'row' });
    const panel = resultPanel(ctx, { getDetails: () => details });

    async function start(deviceId) {
      stopStream(stream);
      stream = null;
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: {
            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        });
        if (disposed) return stopStream(s);
        stream = s;
        video.srcObject = s;
        const track = s.getVideoTracks()[0];
        const st = track.getSettings();
        details = { device: track.label, resolution: `${st.width}×${st.height}`, fps: Math.round(st.frameRate || 0) || null };
        info.textContent = `${track.label} — ${details.resolution}${details.fps ? ` @ ${details.fps} fps` : ''} (max offered by camera)`;
      } catch (err) {
        info.textContent = `Could not open camera: ${err.message}`;
        details = { error: err.message };
      }
    }

    (async () => {
      const { select, devices } = await deviceSelect('videoinput', (id) => start(id));
      if (disposed) return;
      if (!devices.length) {
        info.textContent = 'No camera detected. Mark Fail if this model should have one, or N/A if it does not.';
        return;
      }
      controls.append(el('label', { class: 'field inline' }, el('span', {}, 'Camera'), select));
      controls.append(
        el('button', { class: 'btn ghost', onclick: () => video.classList.toggle('mirrored') }, 'Mirror'),
      );
      start(devices[0].deviceId);
    })();

    root.append(controls, el('div', { class: 'stage' }, video), info, panel.node);
    return () => {
      disposed = true;
      stopStream(stream);
      panel.dispose();
    };
  },
};
