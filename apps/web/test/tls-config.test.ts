import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function configuration(flag?: string) {
  const env = { ...process.env };
  delete env.LOCHO_LOCAL_TLS_TEST;
  delete env.LOCHO_DEPLOY_URL;
  if (flag !== undefined) {
    env.LOCHO_LOCAL_TLS_TEST = flag;
    env.LOCHO_DEPLOY_URL = 'https://localhost:8443';
  }
  // A new process avoids cached config/environment state across test cases.
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      `import config from './playwright.config.ts';
      console.log(JSON.stringify({
        ignoreHTTPSErrors: config.use.ignoreHTTPSErrors,
        projects: config.projects.map(project => ({
          name: project.name, args: project.use.launchOptions?.args ?? [],
        })),
      }));`,
    ],
    { cwd: fileURLToPath(new URL('../../../', import.meta.url)), env, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as {
    ignoreHTTPSErrors: boolean;
    projects: { name: string; args: string[] }[];
  };
}

test('normal browser launches retain certificate verification without the exact TLS-test opt-in', () => {
  for (const flag of [undefined, '0', 'true']) {
    const config = configuration(flag);
    assert.equal(config.ignoreHTTPSErrors, false);
    assert.equal(config.projects.length, 3);
    for (const project of config.projects) assert.deepEqual(project.args, []);
  }
});

test('internal-CA fixture enables the service-worker certificate override only for Chromium', () => {
  const config = configuration('1');
  assert.equal(config.ignoreHTTPSErrors, true);
  assert.deepEqual(
    config.projects.map(({ name }) => name),
    ['chromium', 'firefox', 'webkit'],
  );
  for (const project of config.projects)
    assert.deepEqual(
      project.args,
      project.name === 'chromium' ? ['--ignore-certificate-errors'] : [],
    );
});
