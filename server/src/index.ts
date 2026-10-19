import os from 'node:os';
import { configErrors, configWarnings, loadConfig } from './config.ts';
import { createBeamServer } from './server.ts';
import { APP_VERSION } from '@beamdesk/core/protocol';

const config = loadConfig();
const errors = configErrors(config);
if (errors.length) {
  for (const e of errors) console.error(`Configuration error: ${e}`);
  process.exit(1);
}
for (const w of configWarnings(config)) console.warn(`Warning: ${w}`);

// Log and keep serving: one bad request must not take every session down.
process.on('uncaughtException', (err) => console.error('[uncaught]', err));
process.on('unhandledRejection', (err) => console.error('[unhandled rejection]', err));

const server = createBeamServer(config);
const port = await server.listen();

console.log(`BeamDesk server ${APP_VERSION} listening on http://${config.host}:${port}`);
console.log(`  web app:      ${config.webRoot ?? 'not found (run npm run build:web)'}`);
console.log(`  data dir:     ${config.dataDir}`);
console.log(`  access key:   ${config.accessKey ? 'required' : 'not required (public server)'}`);
console.log(`  TURN relay:   ${config.turnUrls.length || config.iceServersJson ? 'configured' : 'not configured (direct connections only)'}`);
if (config.host === '0.0.0.0' || config.host === '::') {
  // Handy for trying BeamDesk from a phone or another computer on the same Wi-Fi.
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => `http://${a!.address}:${port}`);
  if (lan.length) console.log(`  on your network: ${lan.join('  ')}`);
}

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    console.log(`Received ${signal}, shutting down...`);
    await server.close();
    process.exit(0);
  });
}
