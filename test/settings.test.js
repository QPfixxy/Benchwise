'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Settings, migrateLegacyUserData } = require('../src/main/settings');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'benchwise-settings-'));

test('settings and reports move over from the pre-rename Qudit folder', () => {
  const legacy = tmp();
  const data = path.join(tmp(), 'Benchwise');
  fs.writeFileSync(path.join(legacy, 'qudit-settings.json'), JSON.stringify({ stationName: 'Bench 4' }));
  fs.mkdirSync(path.join(legacy, 'reports'));
  fs.writeFileSync(path.join(legacy, 'reports', 'A1.json'), '{}');

  migrateLegacyUserData(legacy, data);
  assert.equal(new Settings(data).get().stationName, 'Bench 4');
  assert.ok(fs.existsSync(path.join(data, 'reports', 'A1.json')));

  // Never overwrites settings that already exist under the new name.
  fs.writeFileSync(path.join(legacy, 'qudit-settings.json'), JSON.stringify({ stationName: 'Old' }));
  migrateLegacyUserData(legacy, data);
  assert.equal(new Settings(data).get().stationName, 'Bench 4');
});

test('a data folder with only the old settings file name still loads', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'qudit-settings.json'), JSON.stringify({ defaultTechnician: 'T1' }));
  const s = new Settings(dir);
  assert.equal(s.get().defaultTechnician, 'T1');
  s.update({ stationName: 'B2' });
  assert.ok(fs.existsSync(path.join(dir, 'benchwise-settings.json')));
});
