'use strict';

// Profiles and pass/fail rules for stress tests. Pure functions (unit-tested).

const PROFILES = {
  cpu: {
    quick: { label: 'Quick: 2 min', durationMs: 2 * 60_000 },
    standard: { label: 'Standard: 10 min', durationMs: 10 * 60_000 },
    burnin: { label: 'Burn-in: 30 min', durationMs: 30 * 60_000 },
  },
  memory: {
    quick: { label: 'Quick: 50% of free RAM, 1 pass', fraction: 0.5, passes: 1 },
    standard: { label: 'Standard: 70% of free RAM, 2 passes', fraction: 0.7, passes: 2 },
    burnin: { label: 'Burn-in: 80% of free RAM, 4 passes', fraction: 0.8, passes: 4 },
  },
};

const THROTTLE_WARN = 0.25; // >25% throughput drop from early to late in the run
const TEMP_WARN_C = 95;
const MIN_MEMORY_COVERAGE = 0.5; // tested < 50% of the target suggests allocation trouble

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const fmtGB = (b) => `${(b / 1024 ** 3).toFixed(1)} GB`;
const fmtDuration = (ms) => {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};

/**
 * Throughput drop between the start and end of the run, as a fraction.
 * Window 0 is skipped (JIT warm-up, threads starting). Needs >= 7 windows.
 */
function throttleDrop(windows = []) {
  const w = windows.slice(1).filter((x) => x > 0);
  if (w.length < 6) return null;
  const early = mean(w.slice(0, 3));
  const late = mean(w.slice(-3));
  return early > 0 ? Math.max(0, 1 - late / early) : null;
}

function telemetrySummary(samples = []) {
  const temps = samples.map((s) => s.tempC).filter((t) => Number.isFinite(t) && t > 0);
  const clocks = samples.map((s) => s.ghz).filter((g) => Number.isFinite(g) && g > 0);
  return {
    maxTempC: temps.length ? Math.round(Math.max(...temps)) : null,
    avgClockGHz: clocks.length ? Math.round(mean(clocks) * 100) / 100 : null,
  };
}

/** Returns { status: 'pass'|'fail'|null, summary, warnings[], details }. null = no automatic verdict. */
function evaluateCpu(result, { telemetry = [], profile } = {}) {
  const warnings = [];
  const drop = throttleDrop(result.windows);
  const t = telemetrySummary(telemetry);
  if (drop !== null && drop > THROTTLE_WARN) {
    warnings.push(`Throughput fell ${Math.round(drop * 100)}% during the run: likely thermal throttling. Check fans, heatsink and thermal paste.`);
  }
  if (t.maxTempC !== null && t.maxTempC >= TEMP_WARN_C) warnings.push(`CPU reached ${t.maxTempC}°C.`);

  const details = {
    profile: PROFILES.cpu[profile]?.label || profile,
    duration: fmtDuration(result.elapsedMs),
    threads: result.threads,
    rounds: result.rounds,
    roundsPerSec: result.elapsedMs ? Math.round((result.rounds / (result.elapsedMs / 1000)) * 10) / 10 : null,
    computationErrors: result.errorCount,
    throttleDrop: drop === null ? null : `${Math.round(drop * 100)}%`,
    maxTempC: t.maxTempC,
    avgClockGHz: t.avgClockGHz,
    errorSamples: (result.errors || []).map((e) => `thread ${e.worker} round ${e.round}: ${e.kernel} kernel returned ${e.got}, expected ${e.expected}`),
    crashes: result.crashes || [],
    warnings,
  };

  if (result.errorCount > 0) {
    return {
      status: 'fail',
      summary: `${result.errorCount} computation error${result.errorCount === 1 ? '' : 's'}: the CPU returned wrong results under load. Typical causes: overheating, failing CPU/VRM, unstable overclock, or bad RAM.`,
      warnings,
      details,
    };
  }
  if (result.crashes?.length || result.fatal) {
    return { status: 'fail', summary: `Stress worker crashed: ${(result.crashes || [result.fatal]).join('; ')}`, warnings, details };
  }
  if (result.aborted) {
    return { status: null, summary: `Stopped after ${details.duration} with no errors. Run to completion for a verdict.`, warnings, details };
  }
  return {
    status: 'pass',
    summary: `${details.duration} on ${result.threads} threads, ${result.rounds} verified rounds, 0 errors.`,
    warnings,
    details,
  };
}

function evaluateMemory(result, { targetBytes, installedBytes, profile } = {}) {
  const warnings = [];
  const coverage = targetBytes ? result.allocated / targetBytes : 1;
  if (coverage < MIN_MEMORY_COVERAGE) {
    warnings.push(`Only ${fmtGB(result.allocated)} of the planned ${fmtGB(targetBytes)} could be allocated.`);
  }
  const details = {
    profile: PROFILES.memory[profile]?.label || profile,
    tested: fmtGB(result.allocated),
    percentOfInstalled: installedBytes ? `${Math.round((result.allocated / installedBytes) * 100)}%` : null,
    passes: PROFILES.memory[profile]?.passes ?? null,
    duration: fmtDuration(result.elapsedMs),
    threads: result.threads,
    errors: result.errorCount,
    errorSamples: (result.errors || []).map((e) => `${e.pattern} pass ${e.pass}: offset ${e.offset} expected ${e.expected} got ${e.got} (bits ${e.bits})`),
    crashes: result.crashes || [],
    note: 'User-space test: memory reserved by the OS is not covered. Use a bootable tester (e.g. MemTest86) on suspect units.',
    warnings,
  };
  if (result.errorCount > 0) {
    return {
      status: 'fail',
      summary: `${result.errorCount} memory error${result.errorCount === 1 ? '' : 's'}: data read back differed from what was written. Reseat or replace the RAM and retest.`,
      warnings,
      details,
    };
  }
  if (result.crashes?.length || result.fatal) {
    return { status: 'fail', summary: `Memory test crashed: ${(result.crashes || [result.fatal]).join('; ')}`, warnings, details };
  }
  if (result.aborted) {
    return { status: null, summary: `Stopped after testing with no errors so far. Run to completion for a verdict.`, warnings, details };
  }
  if (result.allocated === 0) return { status: null, summary: 'Could not allocate memory to test.', warnings, details };
  return {
    status: 'pass',
    summary: `${fmtGB(result.allocated)} tested with ${details.passes} pass(es) of 7 patterns, 0 errors.`,
    warnings,
    details,
  };
}

module.exports = { PROFILES, evaluateCpu, evaluateMemory, throttleDrop, telemetrySummary, fmtGB };
