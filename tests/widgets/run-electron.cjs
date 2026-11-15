'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Set APPDATA before Electron starts; nova.js deliberately shares its usual dev profile.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-widgets-'));
const electron = require('electron');
const env = { ...process.env, APPDATA: root, NOVA_WIDGET_TEST_ROOT: root };
delete env.ELECTRON_RUN_AS_NODE;
for (const [stage, scale] of [['create', '1'], ['restart', '1'], ['scaled', '1.25'], ['scaled', '1.5'], ['scaled', '2']]) {
  const result = spawnSync(electron, [path.join(__dirname, 'electron-smoke.cjs')], {
    env: { ...env, NOVA_WIDGET_TEST_STAGE: stage, NOVA_WIDGET_TEST_SCALE: scale },
    encoding: 'utf8', timeout: 90000, windowsHide: true,
  });
  if (result.status !== 0) {
    console.error(result.stdout, result.stderr);
    if (result.error) console.error(result.error.message);
    console.error('stage:', stage, 'exit:', result.status, 'signal:', result.signal);
    console.error('Electron verification failed. Isolated evidence:', root);
    process.exit(1);
  }
  console.log(`Electron ${stage}, device scale ${scale}: passed`);
}
console.log('WIDGET_ELECTRON_OK');
console.log('Isolated profiles, results and screenshots retained at', root);
