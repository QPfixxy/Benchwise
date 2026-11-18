'use strict';

// The floor Wi-Fi that USB sticks join during Windows setup (the MDM check
// needs internet). Stored on the server, editable by administrators, and
// turned into the Windows WLAN profile (wifi.xml) the stick's launcher loads
// with `netsh wlan add profile`.

const SECURITY = {
  wpa2: { label: 'WPA2-Personal', auth: 'WPA2PSK', encryption: 'AES' },
  wpa3: { label: 'WPA3-Personal', auth: 'WPA3SAE', encryption: 'AES' },
  open: { label: 'Open (no password)', auth: 'open', encryption: 'none' },
};

/** Validates Wi-Fi settings. Returns { errors } or { wifi } (normalised). */
function checkWifi(w) {
  const errors = [];
  const ssid = typeof w?.ssid === 'string' ? w.ssid : '';
  const security = w?.security || 'wpa2';
  const password = typeof w?.password === 'string' ? w.password : '';
  if (!ssid || Buffer.byteLength(ssid, 'utf8') > 32) errors.push('Wi-Fi name (SSID): 1-32 characters.');
  if (/[\u0000-\u001f]/.test(ssid)) errors.push('Wi-Fi name: no control characters.');
  // The name goes into the stick's site.cmd: characters that break batch files are refused.
  if (/[%!"^&<>|]/.test(ssid)) errors.push('Wi-Fi name: these characters can\'t be used on sticks: % ! " ^ & < > |');
  if (!SECURITY[security]) errors.push('Choose the Wi-Fi security: WPA2, WPA3 or open.');
  if (security !== 'open') {
    // WPA passphrases are 8-63 printable ASCII characters.
    if (password.length < 8 || password.length > 63 || !/^[\x20-\x7e]+$/.test(password)) errors.push('Wi-Fi password: 8-63 characters (letters, digits, symbols).');
  }
  if (errors.length) return { errors };
  return { wifi: { ssid, security, password: security === 'open' ? '' : password, hidden: Boolean(w.hidden) } };
}

const xmlEscape = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

/**
 * The Windows WLAN profile XML (as `netsh wlan export profile key=clear`
 * makes it). The profile is named after the SSID, which is what the
 * launcher connects to.
 */
function wlanProfileXml(wifi) {
  const sec = SECURITY[wifi.security] || SECURITY.wpa2;
  const name = xmlEscape(wifi.ssid);
  const hex = Buffer.from(wifi.ssid, 'utf8').toString('hex').toUpperCase();
  const key =
    wifi.security === 'open'
      ? ''
      : `
			<sharedKey>
				<keyType>passPhrase</keyType>
				<protected>false</protected>
				<keyMaterial>${xmlEscape(wifi.password)}</keyMaterial>
			</sharedKey>`;
  return `<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
	<name>${name}</name>
	<SSIDConfig>
		<SSID>
			<hex>${hex}</hex>
			<name>${name}</name>
		</SSID>
		<nonBroadcast>${wifi.hidden ? 'true' : 'false'}</nonBroadcast>
	</SSIDConfig>
	<connectionType>ESS</connectionType>
	<connectionMode>auto</connectionMode>
	<MSM>
		<security>
			<authEncryption>
				<authentication>${sec.auth}</authentication>
				<encryption>${sec.encryption}</encryption>
				<useOneX>false</useOneX>
			</authEncryption>${key}
		</security>
	</MSM>
</WLANProfile>
`.replace(/\n/g, '\r\n');
}

/** What administrators see: everything but the password itself. */
const publicView = (w) => (w ? { ssid: w.ssid, security: w.security || 'wpa2', hidden: Boolean(w.hidden), passwordSet: Boolean(w.password), updatedAt: w.updatedAt || null } : null);

module.exports = { checkWifi, wlanProfileXml, publicView, SECURITY };
