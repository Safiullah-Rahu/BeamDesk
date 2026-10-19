import { loadConfig } from './config.ts';
import { createBeamServer } from './server.ts';
import { APP_VERSION } from '@beamdesk/core/protocol';

const config = loadConfig();
const server = createBeamServer(config);
const port = await server.listen();

console.log(`BeamDesk server ${APP_VERSION} listening on http://${config.host}:${port}`);
console.log(`  web app:      ${config.webRoot ?? 'not found (run npm run build:web)'}`);
console.log(`  data dir:     ${config.dataDir}`);
console.log(`  access key:   ${config.accessKey ? 'required' : 'not required (public server)'}`);
console.log(`  TURN relay:   ${config.turnUrls.length || config.iceServersJson ? 'configured' : 'not configured (direct connections only)'}`);

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
