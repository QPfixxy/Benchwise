#!/usr/bin/env node
'use strict';

// Launches Electron with a clean environment. Tools such as VS Code set
// ELECTRON_RUN_AS_NODE=1 for child processes, which makes Electron start as
// plain Node (no app/BrowserWindow) and crash on boot.
const { spawn } = require('node:child_process');
const electron = require('electron'); // path to the binary when required from Node

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env, windowsHide: false });
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
