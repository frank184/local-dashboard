#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(projectRoot, 'node_modules', '.bin', 'electron');
const profile = process.env.LOCAL_DASHBOARD_HARNESS_PROFILE || '/tmp/local-dashboard-ui-harness';
const port = process.env.LOCAL_DASHBOARD_HARNESS_PORT || '9222';
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
const electronArgs = [projectRoot, `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`];
if (process.env.LOCAL_DASHBOARD_HARNESS_NO_SANDBOX === '1') electronArgs.push('--no-sandbox');

console.log(`Starting an isolated Local Dashboard profile at ${profile}`);
console.log(`Electron DevTools is available on port ${port}; use npm run ui:harness to inspect it.`);

const app = spawn(electron, electronArgs, {
  cwd: projectRoot,
  env: childEnv,
  stdio: 'inherit',
});
app.on('error', (error) => { console.error(`Could not start Electron: ${error.message}`); process.exitCode = 1; });
app.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.kill(signal));
