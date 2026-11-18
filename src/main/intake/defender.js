'use strict';

// Microsoft Defender malware scan, ported from the intake toolkit's v1
// Malware_Scan.ps1 (proven in OOBE), plus the agreed changes:
//
//  1. ALWAYS update definitions first (new; v1 scanned with whatever the
//     Windows image shipped with). A failed update is recorded, and the scan
//     still runs.
//  2. Audit mode, exactly as v1: PUA protection to AuditMode and every threat
//     level's default action to 9 (NoAction), so nothing on the drive is
//     touched. Left that way afterwards, as v1 does: units are wiped by
//     separate software before Windows is reinstalled.
//  3. Quick scan (Start-MpScan -ScanType QuickScan).
//  4. Results, as v1: ANY detection in Defender's history counts as infected.
//     New-this-scan and older detections are listed separately.
//     Files scanned come from event 1001.
//
// Report only: nothing is ever removed. One PowerShell process runs the
// whole sequence and prints one JSON line per stage.

const { spawn } = require('node:child_process');

const SCRIPT = String.raw`
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
function Emit($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 6)); [Console]::Out.Flush() }
function Iso($d) { if ($d) { ([DateTime]$d).ToUniversalTime().ToString('o') } else { $null } }

try { $s = Get-MpComputerStatus -ErrorAction Stop } catch {
  Emit @{ event = 'result'; data = @{ available = $false; error = $_.Exception.Message } }; exit
}
$r = [ordered]@{ available = $true }
$r.before = [ordered]@{ signatures = $s.AntivirusSignatureVersion; signaturesUpdated = (Iso $s.AntivirusSignatureLastUpdated) }

Emit @{ event = 'progress'; step = 'update' }
$upd = [ordered]@{ ok = $false; error = $null }
try { Update-MpSignature -ErrorAction Stop; $upd.ok = $true } catch { $upd.error = $_.Exception.Message }
$r.update = $upd

$s = Get-MpComputerStatus -ErrorAction SilentlyContinue
$r.defender = [ordered]@{
  product = $s.AMProductVersion; engine = $s.AMEngineVersion
  signatures = $s.AntivirusSignatureVersion; signaturesUpdated = (Iso $s.AntivirusSignatureLastUpdated)
  realTimeProtection = [bool]$s.RealTimeProtectionEnabled; tamperProtected = [bool]$s.IsTamperProtected
}

Emit @{ event = 'progress'; step = 'audit' }
Set-MpPreference -PUAProtection AuditMode -ErrorAction SilentlyContinue
Set-MpPreference -HighThreatDefaultAction 9 -SevereThreatDefaultAction 9 -ModerateThreatDefaultAction 9 -LowThreatDefaultAction 9 -ErrorAction SilentlyContinue
$p = Get-MpPreference -ErrorAction SilentlyContinue
$r.auditMode = [bool]($p -and $p.LowThreatDefaultAction -eq 9 -and $p.ModerateThreatDefaultAction -eq 9 -and $p.HighThreatDefaultAction -eq 9 -and $p.SevereThreatDefaultAction -eq 9)

Emit @{ event = 'progress'; step = 'scan' }
$start = Get-Date
$scanError = $null
try { Start-MpScan -ScanType QuickScan -ErrorAction Stop } catch { $scanError = $_.Exception.Message }
$r.durationSeconds = [int]((Get-Date) - $start).TotalSeconds
$r.scanError = $scanError

Emit @{ event = 'progress'; step = 'results' }
Start-Sleep -Milliseconds 1500
$r.filesScanned = $null
$ev = Get-WinEvent -ProviderName 'Microsoft-Windows-Windows Defender' -MaxEvents 15 -ErrorAction SilentlyContinue | Where-Object { $_.Id -eq 1001 } | Select-Object -First 1
if ($ev -and $ev.Message -match 'Files scanned:\s*([\d,.]+)') { $r.filesScanned = $Matches[1] }

$catalog = @{}
foreach ($t in @(Get-MpThreat -ErrorAction SilentlyContinue)) { $catalog[[string]$t.ThreatID] = $t }
$threats = @()
foreach ($d in @(Get-MpThreatDetection -ErrorAction SilentlyContinue)) {
  $info = $catalog[[string]$d.ThreatID]
  $threats += [ordered]@{
    name = if ($info) { $info.ThreatName } else { "ThreatID $($d.ThreatID)" }
    severityId = if ($info) { $info.SeverityID } else { $null }
    detectedAt = (Iso $d.InitialDetectionTime)
    newThisScan = [bool]($d.InitialDetectionTime -and ([DateTime]$d.InitialDetectionTime) -ge $start)
    resources = @($d.Resources | ForEach-Object { [string]$_ })
  }
}
$r.threats = $threats
Emit @{ event = 'result'; data = $r }
`;

const SEVERITY = { 0: 'Unknown', 1: 'Low', 2: 'Moderate', 4: 'High', 5: 'Severe' };

// Threat locations are evidence, but C:\Users\<name>\... can hold a previous
// owner's account name. Keep the path, drop the name (setup accounts stay:
// they aren't personal).
function redactUser(location) {
  return String(location).replace(/([\\/]Users[\\/])(?!defaultuser\d+[\\/]|Public[\\/]|Default[\\/])[^\\/]+/gi, '$1<user>');
}

/** Pure: raw script output -> scan result (v1 rules: any detection = infected). */
function interpretScan(data) {
  if (!data || data.available === false) {
    return { status: 'unavailable', message: data?.error ? `Microsoft Defender isn't available: ${data.error}` : "Microsoft Defender isn't available on this device.", threats: [] };
  }
  const threats = (data.threats || []).map((t) => ({ ...t, resources: (t.resources || []).map(redactUser), severity: SEVERITY[t.severityId] || null }));
  const files = data.filesScanned != null ? Number(String(data.filesScanned).replace(/[,.]/g, '')) : null;
  const result = {
    status: threats.length ? 'infected' : 'clean',
    threats,
    newThreats: threats.filter((t) => t.newThisScan).length,
    filesScanned: Number.isFinite(files) ? files : null,
    durationSeconds: data.durationSeconds ?? null,
    definitionsUpdated: Boolean(data.update?.ok),
    updateError: data.update?.error || null,
    defender: data.defender || null,
    auditMode: Boolean(data.auditMode),
    scanError: data.scanError || null,
  };
  if (data.scanError && !threats.length) {
    result.status = 'error';
    result.message = `The scan didn't complete: ${data.scanError}`;
  }
  return result;
}

/**
 * Pure: result -> test verdict. Malware is recorded, not failed, by default
 * (site setting); the audit still shows it plainly.
 */
function malwareVerdict(r, { malwareFails = false } = {}) {
  const notes = [];
  if (!r.definitionsUpdated && r.status !== 'unavailable') notes.push(`definitions NOT updated${r.updateError ? ` (${r.updateError})` : ''}`);
  if (r.status === 'infected' && !r.auditMode) notes.push('audit mode was blocked (Tamper Protection), so Defender may have acted on the threats');
  const tail = notes.length ? ` Note: ${notes.join('; ')}.` : '';
  switch (r.status) {
    case 'clean':
      return { status: 'pass', summary: `Clean: no threats or unwanted apps found${r.filesScanned ? ` (${r.filesScanned.toLocaleString('en-US')} files)` : ''}.${tail}` };
    case 'infected': {
      const names = [...new Set(r.threats.map((t) => t.name))];
      return {
        status: malwareFails ? 'fail' : 'pass',
        summary: `Threats found: ${names.length} (${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''}). Documented and left in place, not removed.${malwareFails ? '' : ' Recorded, not failed.'}${tail}`,
      };
    }
    default:
      return { status: null, summary: r.message || 'The scan did not finish.' };
  }
}

/**
 * Runs the scan. Resolves with the interpreted result; progress events
 * ({ step: 'update' | 'audit' | 'scan' | 'results' }) go to onProgress.
 */
function runDefenderScan({ onProgress = () => {}, spawnFn = spawn, timeoutMs = 45 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
    const child = spawnFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
    });
    let buffer = '';
    let data = null;
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const handleLine = (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.event === 'progress') onProgress({ step: msg.step });
        else if (msg.event === 'result') data = msg.data;
      } catch {
        /* not one of our lines */
      }
    };
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        handleLine(buffer.slice(0, i).trim());
        buffer = buffer.slice(i + 1);
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ status: 'error', message: `Couldn't start PowerShell: ${err.message}`, threats: [] });
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (buffer.trim()) handleLine(buffer.trim());
      resolve(data ? { ...interpretScan(data), checkedAt: new Date().toISOString() } : { status: 'error', message: 'The scan stopped without a result.', threats: [] });
    });
  });
}

module.exports = { runDefenderScan, interpretScan, malwareVerdict, redactUser, SCRIPT };
