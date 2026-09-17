/**
 * Build the browser bundle.
 *
 * The web shell loads client modules through `window.__ModuleLoader__`, so the
 * bundled output is wrapped in that loader protocol and written to
 * `lib/client.js` — the path `package.json#exports["./client"]` points at.
 * React stays external because the shell provides it.
 *
 * @module dsh-lark-session-monitor/build
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(sourceDirectory, '..');
const outputPath = resolve(packageRoot, 'lib/client.js');
const loaderId = process.env.LSM_CLIENT_ID ?? 'dsh-lark-session-monitor';

const result = await build({
  entryPoints: [resolve(packageRoot, 'src/client/index.js')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome100'],
  external: ['react', 'react-dom'],
  write: false,
  minify: process.env.NODE_ENV === 'production',
  legalComments: 'none',
});

const bundled = result.outputFiles?.[0]?.text;
if (!bundled) throw new Error('esbuild did not produce a client bundle');

const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(loaderId)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${bundled}
    return module.exports;
  },
});
`;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, wrapped, 'utf8');
process.stdout.write(`built ${outputPath}\n`);
