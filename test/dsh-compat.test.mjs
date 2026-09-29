/**
 * Release-metadata compatibility checks.
 *
 * The plugin is installed into a DSH profile, so its peer ranges determine
 * whether a supported Harness release can install the bundle at all. Keep the
 * declared release line in sync with the runtime contract exercised by the
 * integration tests.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const packageUrl = new URL('../package.json', import.meta.url);

async function manifest() {
  return JSON.parse(await readFile(packageUrl, 'utf8'));
}

test('the 2.0.0 release manifest matches the verified 0.2 runtime package surface', async () => {
  const pkg = await manifest();
  assert.equal(pkg.version, '2.0.0', 'release version must be 2.0.0');
  const dshPeers = Object.entries(pkg.peerDependencies)
    .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'));

  assert.ok(dshPeers.length > 0, 'expected DSH peer dependencies');
  for (const [name, range] of dshPeers) {
    assert.match(
      range,
      /0\.2\.0-rc\.1/,
      `${name} must accept DSH 0.2.0-rc.1`,
    );
  }
  assert.ok(
    !Object.hasOwn(pkg.peerDependencies, '@deepseek-ai/dsh-client-runtime'),
    'the removed dsh-client-runtime package must not block installation',
  );
  assert.ok(
    !pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-runtime'),
    'the Web client must not request the removed dsh-client-runtime package',
  );
});
