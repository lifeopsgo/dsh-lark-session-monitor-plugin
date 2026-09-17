/**
 * Build the Host bundle.
 *
 * The Host half is bundled to `lib/index.js` for one reason: the profile
 * installs this package by path (`link:`), and Node resolves a linked
 * package's own imports from the package directory. Bundling in the workspace
 * dependencies (currently only Schemastery) keeps the installed plugin
 * self-contained regardless of how the profile hoists `node_modules`.
 *
 * @module dsh-lark-session-monitor/build-host
 */

import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(sourceDirectory, '..');
const outputPath = resolve(packageRoot, 'lib/index.js');

const result = await build({
  entryPoints: [resolve(packageRoot, 'src/index.mjs')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  // Harness packages stay external and resolve from the installing profile,
  // exactly as the shipped plugins do. Bundling them would duplicate the
  // Cordis/service identities and break the runtime's identity checks.
  external: ['@deepseek-ai/*'],
  write: false,
  sourcemap: false,
  legalComments: 'none',
});

const bundled = result.outputFiles?.[0]?.text;
if (!bundled) throw new Error('esbuild did not produce a host bundle');

await mkdir(dirname(outputPath), { recursive: true });
await (await import('node:fs/promises')).writeFile(outputPath, bundled, 'utf8');
process.stdout.write(`built ${outputPath}\n`);
