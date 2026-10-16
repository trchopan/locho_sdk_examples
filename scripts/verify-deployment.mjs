import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const project = `notes-acceptance-${process.pid}`;
const webContainer = `${project}-web`;
function docker(args, capture = false) {
  const result = spawnSync('docker', ['compose', '-p', project, '-f', 'deploy/compose.yaml', ...args], { cwd: root, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.status !== 0) throw new Error(`Compose failed (${result.status})`);
  return result.stdout;
}
const config = JSON.parse(docker(['config', '--format', 'json'], true));
if (config.services.api.ports || config.services.locho.ports || !config.networks.private.internal) throw new Error('Backend must not expose public ingress');
const directory = await mkdtemp(join(tmpdir(), 'notes-deploy-input-'));
try {
  docker(['build']);
  docker(['run', '--rm', 'seed']);
  docker(['up', '-d', '--wait', '--wait-timeout', '90']);
  const ticket = docker(['exec', '-T', 'locho', 'locho', 'share', 'sample-api', '--config', '/etc/locho/locho.toml', '--ticket'], true).trim();
  if (!ticket.startsWith('locho1:') || ticket.includes('\n')) throw new Error('Invalid deployed ticket');
  const input = join(directory, 'ticket'); await writeFile(input, ticket, { mode: 0o600 });
  const result = spawnSync('npx', ['--no-install', 'playwright', 'test', 'deployment.spec.ts'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, LOCHO_DEPLOY_TICKET_FILE: input },
  });
  if (result.status !== 0) throw new Error('Deployed browser acceptance failed');
  console.log('Private Compose health/login/CRUD acceptance passed');
  const caddyfile = (await readFile(join(root, 'deploy/Caddyfile'), 'utf8'))
    .replace('{$NOTES_HOSTNAME} {', 'https://localhost:8443 {\n    tls internal');
  const configFile = join(directory, 'Caddyfile'); await writeFile(configFile, caddyfile);
  const caddy = spawnSync('docker', ['run', '-d', '--name', webContainer,
    '-p', '127.0.0.1::8443', '-v', `${configFile}:/etc/caddy/Caddyfile:ro`,
    '-v', `${join(root, 'apps/web/dist')}:/srv:ro`, 'caddy:2.10.2'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (caddy.status !== 0) throw new Error('HTTPS container failed to start');
  const port = spawnSync('docker', ['port', webContainer, '8443/tcp'], { encoding: 'utf8' });
  if (port.status !== 0) throw new Error('HTTPS port lookup failed');
  const url = `https://localhost:${port.stdout.trim().split(':').at(-1)}`;
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const probe = spawnSync('curl', ['--silent', '--fail', '--insecure', '--max-time', '2', url], { stdio: 'ignore' });
    if (probe.status === 0) { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!ready) { spawnSync('docker', ['logs', webContainer], { stdio: 'inherit' }); throw new Error('HTTPS readiness timeout'); }
  const https = spawnSync('npx', ['--no-install', 'playwright', 'test', 'deployment.spec.ts'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, LOCHO_DEPLOY_TICKET_FILE: input,
      LOCHO_DEPLOY_URL: url, LOCHO_LOCAL_TLS_TEST: '1' },
  });
  if (https.status !== 0) throw new Error('HTTPS/CSP browser acceptance failed');
  console.log('Caddy HTTPS/CSP/WASM acceptance passed (test-only internal CA)');
} finally {
  spawnSync('docker', ['rm', '-fv', webContainer], { stdio: 'ignore' });
  // This verifier owns its uniquely named project and disposable volumes only.
  try { docker(['down', '--volumes', '--remove-orphans']); } finally { await rm(directory, { recursive: true, force: true }); }
}
