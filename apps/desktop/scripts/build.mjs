// Bundles the Electron main + preload scripts and copies the web UI next to them.
//   node scripts/build.mjs          production build
//   node scripts/build.mjs --dev    unminified, with sourcemaps
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dev = process.argv.includes('--dev');
const webDist = path.resolve(root, '../web/dist');

if (!fs.existsSync(path.join(webDist, 'index.html'))) {
  console.error('The web UI is not built yet. Run "npm run build:web" from the repository root first.');
  process.exit(1);
}

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  // bufferutil / utf-8-validate: optional native speedups of the ws package, not shipped.
  external: ['electron', '@jitsi/robotjs', 'bufferutil', 'utf-8-validate'],
  // server/src/config.ts looks for its web root via import.meta.url, which host mode never uses.
  logOverride: { 'empty-import-meta': 'silent' },
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  logLevel: 'info',
  define: {
    __BEAMDESK_SERVER__: JSON.stringify(process.env.BEAMDESK_SERVER_URL ?? ''),
  },
};

await build({ ...common, entryPoints: [path.join(root, 'src/main.ts')], outfile: path.join(root, 'dist/main.cjs') });
await build({ ...common, entryPoints: [path.join(root, 'src/preload.ts')], outfile: path.join(root, 'dist/preload.cjs') });

const webOut = path.join(root, 'web');
fs.rmSync(webOut, { recursive: true, force: true });
fs.cpSync(webDist, webOut, { recursive: true });
console.log(`Copied web UI to ${path.relative(process.cwd(), webOut) || webOut}`);
