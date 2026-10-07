'use strict';

const fs = require('fs');

const file = '/app/agent.js';
const source = fs.readFileSync(file, 'utf8');

if (!source.includes("const AGENT_VERSION = '2.2.0';")) {
  throw new Error('agent compatibility check failed: expected AGENT_VERSION 2.2.0');
}

for (const required of [
  'async function runnerBusyFetch() {',
  'async function runnerBusy(force = false) {',
  'RUNNER_STATUS_CACHE_SECONDS',
  'runnerBusy(true)',
]) {
  if (!source.includes(required)) {
    throw new Error(`agent compatibility check failed: missing ${required}`);
  }
}

console.log('[agent-build] runner busy-state cache already integrated; compatibility check passed');
