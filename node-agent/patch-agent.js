'use strict';

const fs = require('fs');
const file = '/app/agent.js';
let source = fs.readFileSync(file, 'utf8');

function replaceOnce(from, to, label) {
  if (!source.includes(from)) throw new Error(`agent patch failed: ${label}`);
  source = source.replace(from, to);
}

replaceOnce("const AGENT_VERSION = '2.1.0';", "const AGENT_VERSION = '2.2.0';", 'version');
replaceOnce(
  'let lastRecoveryAt = 0;',
  `let lastRecoveryAt = 0;\nconst RUNNER_STATUS_CACHE_SECONDS = Math.max(30, Math.min(Number(process.env.NODE_RUNNER_STATUS_CACHE_SECONDS || 90), 600));\nlet runnerBusyCachedValue = null;\nlet runnerBusyCachedAt = 0;`,
  'runner status cache state',
);
replaceOnce('async function runnerBusy() {', 'async function runnerBusyFetch() {', 'rename runnerBusy');
replaceOnce(
  '\nfunction watchdogState(busy, diag) {',
  `\nasync function runnerBusy(force = false) {\n  const age = Date.now() - runnerBusyCachedAt;\n  if (!force && runnerBusyCachedAt && age < RUNNER_STATUS_CACHE_SECONDS * 1000) return runnerBusyCachedValue;\n  const value = await runnerBusyFetch();\n  // Keep the last known value through a temporary API failure/rate limit, but\n  // never make an unknown first lookup look idle.\n  if (value !== null) {\n    runnerBusyCachedValue = value;\n    runnerBusyCachedAt = Date.now();\n  } else if (!runnerBusyCachedAt) {\n    runnerBusyCachedValue = null;\n    runnerBusyCachedAt = Date.now();\n  }\n  return runnerBusyCachedValue;\n}\n\nfunction watchdogState(busy, diag) {`,
  'cached runnerBusy wrapper',
);
replaceOnce('if (await runnerBusy() !== true) return;', 'if (await runnerBusy(true) !== true) return;', 'watchdog fresh runner check');
replaceOnce('if (await runnerBusy() === true) {', 'if (await runnerBusy(true) === true) {', 'cleanup fresh runner check');

fs.writeFileSync(file, source);
console.log(`[agent-build] patched runner API busy-state cache to ${process.env.NODE_RUNNER_STATUS_CACHE_SECONDS || 90}s; safety checks remain fresh`);
