import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import http from 'node:http';
import { classifyIPv4, gatewayFromProcRoute, gatewayFromRouteOutput } from '../src/netinfo.ts';
import { parseDescription, PortMapper } from '../src/portmap.ts';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

/** A router that speaks UPnP IGD: an SSDP responder plus the description and control URLs. */
async function fakeIgd(opts: { failWith?: (lease: string) => number | null; location?: (port: number) => string } = {}) {
  const calls: { action: string; body: string }[] = [];
  const web = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/desc.xml') {
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(`<?xml version="1.0"?><root><device><serviceList>
          <service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType><controlURL>/l3f</controlURL></service>
          <service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl?x=1&amp;y=2</controlURL></service>
        </serviceList></device></root>`);
      }
      const action = /#(\w+)"/.exec(String(req.headers.soapaction))?.[1] ?? '';
      calls.push({ action, body });
      const lease = /<NewLeaseDuration>(\d+)</.exec(body)?.[1] ?? '';
      const code = action === 'AddPortMapping' ? opts.failWith?.(lease) : null;
      if (code) {
        res.writeHead(500, { 'Content-Type': 'text/xml' });
        return res.end(`<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>${code}</errorCode><errorDescription>nope</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`);
      }
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(action === 'GetExternalIPAddress' ? '<u:R><NewExternalIPAddress>81.2.69.160</NewExternalIPAddress></u:R>' : '<ok/>');
    });
  });
  await new Promise<void>((r) => web.listen(0, '127.0.0.1', () => r()));
  const webPort = (web.address() as { port: number }).port;
  const ssdp = dgram.createSocket('udp4');
  await new Promise<void>((r) => ssdp.bind(0, '127.0.0.1', () => r()));
  ssdp.on('message', (msg, rinfo) => {
    if (!msg.toString().startsWith('M-SEARCH')) return;
    const location = opts.location?.(webPort) ?? `http://127.0.0.1:${webPort}/desc.xml`;
    ssdp.send(`HTTP/1.1 200 OK\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\nLOCATION: ${location}\r\n\r\n`, rinfo.port, rinfo.address);
  });
  cleanup.push(() => new Promise((r) => web.close(r)), () => ssdp.close());
  return { calls, ssdpTarget: { address: '127.0.0.1', port: ssdp.address().port } };
}

/** A router that speaks NAT-PMP. */
async function fakeNatPmp() {
  const calls: Buffer[] = [];
  const s = dgram.createSocket('udp4');
  await new Promise<void>((r) => s.bind(0, '127.0.0.1', () => r()));
  s.on('message', (msg, rinfo) => {
    calls.push(msg);
    if (msg[1] === 0) return s.send(Buffer.from([0, 128, 0, 0, 0, 0, 0, 1, 81, 2, 69, 160]), rinfo.port, rinfo.address);
    const res = Buffer.alloc(16);
    res[1] = 128 + msg[1];
    msg.copy(res, 8, 4, 6); // internal port
    res.writeUInt16BE(msg.readUInt16BE(4) + 1000, 10); // the router picks another external port
    msg.copy(res, 12, 8, 12);
    s.send(res, rinfo.port, rinfo.address);
  });
  cleanup.push(() => s.close());
  return { calls, port: s.address().port };
}

const ports = [
  { protocol: 'TCP' as const, port: 41443 },
  { protocol: 'UDP' as const, port: 41443 },
];

test('UPnP: maps both ports, learns the address, removes the mappings on stop', async () => {
  const igd = await fakeIgd();
  const mapper = new PortMapper({ internalAddress: '127.0.0.1', ports, ssdpTarget: igd.ssdpTarget, timeoutMs: 800 });
  const r = await mapper.start();
  assert.equal(r.method, 'upnp');
  assert.equal(r.externalIp, '81.2.69.160');
  assert.deepEqual(r.mappings.map((m) => `${m.protocol}:${m.externalPort}`), ['TCP:41443', 'UDP:41443']);
  const adds = igd.calls.filter((c) => c.action === 'AddPortMapping');
  assert.equal(adds.length, 2);
  assert.match(adds[0].body, /<NewInternalClient>127\.0\.0\.1<\/NewInternalClient>/);
  assert.match(adds[0].body, /<NewLeaseDuration>3600<\/NewLeaseDuration>/);
  await mapper.stop();
  assert.equal(igd.calls.filter((c) => c.action === 'DeletePortMapping').length, 2);
});

test('UPnP: routers that only allow permanent mappings', async () => {
  const igd = await fakeIgd({ failWith: (lease) => (lease === '0' ? null : 725) });
  const mapper = new PortMapper({ internalAddress: '127.0.0.1', ports, ssdpTarget: igd.ssdpTarget, timeoutMs: 800 });
  assert.equal((await mapper.start()).method, 'upnp');
  await mapper.stop();
  assert.equal(igd.calls.filter((c) => c.action === 'DeletePortMapping').length, 2, 'permanent mappings are removed by us');
});

test('UPnP: a port forwarded to another device is reported', async () => {
  const igd = await fakeIgd({ failWith: () => 718 });
  const mapper = new PortMapper({ internalAddress: '127.0.0.1', ports, ssdpTarget: igd.ssdpTarget, timeoutMs: 400 });
  await assert.rejects(mapper.start(), /already forwarded to another device/);
});

test('UPnP answers pointing somewhere else are ignored; NAT-PMP takes over', async () => {
  const igd = await fakeIgd({ location: (p) => `http://10.9.8.7:${p}/desc.xml` });
  const pmp = await fakeNatPmp();
  const mapper = new PortMapper({ internalAddress: '127.0.0.1', ports, ssdpTarget: igd.ssdpTarget, gateway: '127.0.0.1', natPmpPort: pmp.port, timeoutMs: 400 });
  const r = await mapper.start();
  assert.equal(igd.calls.length, 0, 'never contacted the address in the answer');
  assert.equal(r.method, 'nat-pmp');
  assert.equal(r.externalIp, '81.2.69.160');
  assert.deepEqual(r.mappings, [
    { protocol: 'TCP', internalPort: 41443, externalPort: 42443 },
    { protocol: 'UDP', internalPort: 41443, externalPort: 42443 },
  ]);
  const before = pmp.calls.length;
  await mapper.stop();
  const deletes = pmp.calls.slice(before);
  assert.equal(deletes.length, 2);
  assert.ok(deletes.every((m) => m.readUInt32BE(8) === 0), 'lifetime 0 removes the mapping');
});

test('read-only lookup of the router address', async () => {
  const pmp = await fakeNatPmp();
  const mapper = new PortMapper({ internalAddress: '127.0.0.1', ports, ssdpTarget: { address: '127.0.0.1', port: 9 }, gateway: '127.0.0.1', natPmpPort: pmp.port, timeoutMs: 300 });
  assert.equal(await mapper.lookupExternalIp(), '81.2.69.160');
  assert.ok(pmp.calls.every((m) => m[1] === 0), 'nothing was mapped');
});

test('no router at all', async () => {
  const mapper = new PortMapper({ internalAddress: '127.0.0.1', ports, ssdpTarget: { address: '127.0.0.1', port: 9 }, gateway: null, timeoutMs: 300 });
  await assert.rejects(mapper.start(), /UPnP: .*NAT-PMP: /);
});

test('device descriptions: the control URL must stay on the router', () => {
  const xml = (url: string) => `<root><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>${url}</controlURL></service></root>`;
  assert.equal(parseDescription(xml('/ctl'), 'http://192.168.1.1:5000/d.xml')?.controlUrl, 'http://192.168.1.1:5000/ctl');
  assert.equal(parseDescription(xml('http://evil.example/ctl'), 'http://192.168.1.1:5000/d.xml'), null);
  assert.equal(parseDescription(xml('file:///etc/passwd'), 'http://192.168.1.1:5000/d.xml'), null);
  assert.equal(parseDescription('<root/>', 'http://192.168.1.1/d.xml'), null);
});

test('address classes', () => {
  const cases: Record<string, string> = {
    '127.0.0.1': 'loopback',
    '10.1.2.3': 'private',
    '172.16.0.1': 'private',
    '172.32.0.1': 'public',
    '192.168.0.10': 'private',
    '100.64.0.1': 'cgnat',
    '100.127.255.254': 'cgnat',
    '100.128.0.1': 'public',
    '169.254.1.1': 'link-local',
    '8.8.8.8': 'public',
    '0.1.2.3': 'reserved',
    '224.0.0.1': 'reserved',
    '203.0.113.9': 'public',
    '198.18.0.1': 'reserved',
    'fe80::1': 'reserved',
  };
  for (const [ip, kind] of Object.entries(cases)) assert.equal(classifyIPv4(ip), kind, ip);
});

test('default gateway from the routing table', () => {
  const proc = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\nwlan0\t0000A8C0\t00000000\t0001\t0\t0\t600\t00FFFFFF\nwlan0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\n';
  assert.equal(gatewayFromProcRoute(proc), '192.168.1.1');
  const win = `IPv4 Route Table
===========================================================================
Active Routes:
Network Destination        Netmask          Gateway       Interface  Metric
          0.0.0.0          0.0.0.0     10.0.0.138       10.0.0.42     35
          0.0.0.0          0.0.0.0    192.168.56.1   192.168.56.10     5
`;
  assert.equal(gatewayFromRouteOutput(win, '10.0.0.42'), '10.0.0.138');
  assert.equal(gatewayFromRouteOutput(win), '192.168.56.1', 'lowest metric without a hint');
  assert.equal(gatewayFromRouteOutput('   route to: default\ndestination: default\n    gateway: 192.168.0.1\n  interface: en0\n'), '192.168.0.1');
});
