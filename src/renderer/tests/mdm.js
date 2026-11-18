import { el, fill, toast } from '../dom.js';
import { resultPanel } from './common.js';
import { setBusy } from '../app.js';

const clean = (msg) => String(msg).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// Big result panel per outcome (colors match the intake toolkit's screens).
const LOOK = {
  clean: ['ok', '✓ Clean'],
  locked: ['missing', '✕ Locked'],
  ghost: ['warn', '⚠ Ghost profile: check by hand'],
  unconfirmed: ['warn', '⚠ Clean, but not confirmed by Microsoft'],
  unverified: ['warn', "⚠ Can't verify"],
};

export default {
  id: 'mdm',
  name: 'MDM / Autopilot',
  description:
    "Checks whether this unit is still registered to an organisation through Windows Autopilot (an MDM lock). Runs during Windows setup (OOBE), when the unit asks Microsoft for its Autopilot profile. Takes 30–60 seconds.",
  mount(root, ctx) {
    const body = el('div', { class: 'mdm-check' });
    const runBtn = el('button', { class: 'btn primary big', onclick: () => run() }, 'Run check');
    const progressLine = el('p', { class: 'muted' });
    let running = false;

    const offProgress = ctx.api.mdm.onProgress((p) => {
      progressLine.textContent =
        p.step === 'network'
          ? `Checking the connection to Microsoft (attempt ${p.attempt} of ${p.of})…`
          : p.step === 'confirm'
            ? `Waiting for Microsoft's answer (${p.round} of ${p.of})…`
            : `Looking for an Autopilot profile (${p.round} of ${p.of})…`;
    });

    function applyVerdict(res) {
      const cur = ctx.result;
      // Don't overwrite a verdict the technician set by hand.
      if (cur && cur.status !== 'untested' && cur.details?.source !== 'mdm') return;
      ctx.setResult({
        status: res.verdict.status || 'untested',
        details: {
          source: 'mdm',
          summary: res.verdict.summary,
          result: res.status,
          safetyNet: res.safetyNet,
          microsoft: res.policyCache?.errorReason ? `${res.policyCache.errorCode} ${res.policyCache.errorReason} (${res.policyCache.downloadedAt || 'no date'})` : null,
          tenant: res.tenant,
          client: res.vendor,
          registryPath: res.registryPath,
        },
      });
    }

    async function run() {
      running = true;
      runBtn.disabled = true;
      progressLine.textContent = 'Starting…';
      setBusy('mdm', true);
      render();
      try {
        const res = await ctx.api.mdm.run();
        ctx.state.mdm = res;
        applyVerdict(res);
      } catch (err) {
        toast(clean(err.message), 'error');
      } finally {
        running = false;
        runBtn.disabled = false;
        setBusy('mdm', false);
        render();
      }
    }

    function render() {
      const res = ctx.state.mdm;
      if (running) return fill(body, el('div', { class: 'row' }, el('span', { class: 'spinner' }), progressLine));
      if (!res) return fill(body);
      const [cls, title] = res.status === 'ghost' && res.safetyNet ? ['warn', '⚠ Possible lock: check by hand'] : LOOK[res.status] || ['na', 'No result'];
      const sys = ctx.state.hardware?.system || {};
      const failedChecks = (res.network?.checks || []).filter((c) => !c.ok).map((c) => c.target);
      fill(
        body,
        el(
          'div',
          { class: `notice ${cls} mdm-result` },
          el('strong', { class: 'mdm-title' }, title),
          el('p', {}, res.verdict?.summary),
          res.status === 'locked' && res.vendor ? el('p', {}, `Client: ${res.vendor}`) : null,
          res.tenant ? el('p', { class: 'small' }, `Tenant: ${res.tenant}`) : null,
          res.status === 'unverified' && failedChecks.length ? el('p', { class: 'small' }, `Not reachable: ${failedChecks.join(', ')}`) : null,
          el('p', { class: 'muted small' }, [sys.manufacturer, sys.model, sys.serial && `S/N ${sys.serial}`].filter(Boolean).join(' · ')),
        ),
        el(
          'p',
          { class: 'muted small' },
          [
            `Checked in ${Math.round((res.durationMs || 0) / 1000)} s`,
            res.knownTenantsSource ? `known tenants: ${res.knownTenantsSource} (${res.knownTenants})` : 'no known-tenants list loaded',
          ].join(' · '),
        ),
      );
    }

    const panel = resultPanel(ctx, {
      naLabel: 'N/A',
      hint: `Clean passes${ctx.state.settings?.mdmLockedFails === false ? '' : ' and Locked fails'} automatically. A ghost profile or an unreachable network needs your decision: record it here, with a note.`,
    });
    root.append(el('div', { class: 'row' }, runBtn), body, panel.node);
    if (ctx.state.mdm) render();
    else run();
    return () => {
      offProgress();
      panel.dispose();
    };
  },
};
