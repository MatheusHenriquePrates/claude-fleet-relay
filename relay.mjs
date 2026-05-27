import http from 'node:http';
import { loadNetworks } from './src/loader.mjs';
import { findNetworkByToken, checkAcl } from './src/acl.mjs';
import { deliverToPod, clearPodCache } from './src/kubectl.mjs';
import { audit } from './src/audit.mjs';

const PORT = parseInt(process.env.PORT || '4510', 10);
const NETWORKS_CONFIG_PATH = process.env.NETWORKS_CONFIG_PATH || './config/networks.json';

const networks = loadNetworks(NETWORKS_CONFIG_PATH);
const networkNames = Object.keys(networks);
if (networkNames.length === 0) {
  console.error(`[fatal] No networks declared in ${NETWORKS_CONFIG_PATH}`);
  process.exit(1);
}

function reply(res, code, obj, extraHeaders = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(JSON.stringify(obj));
}

function err(res, code, errorCode, message, extra = {}) {
  reply(res, code, { ok: false, errorCode, message, ...extra });
}

function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function getBearer(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

const server = http.createServer(async (req, res) => {
  const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');

  // --- Public health/banner ---
  if (req.url === '/health' && req.method === 'GET') {
    return reply(res, 200, {
      ok: true,
      service: 'claude-fleet-relay',
      networks: networkNames,
    });
  }

  if (req.url === '/' && req.method === 'GET') {
    return reply(res, 200, { service: 'claude-fleet-relay', networks: networkNames });
  }

  // --- Inter-bot message delivery ---
  // POST /send
  // Headers: Authorization: Bearer <network-token>
  // Body: { "from": "<botId>", "to": "<botId>", "message": "..." }
  if (req.url === '/send' && req.method === 'POST') {
    const token = getBearer(req);
    const network = findNetworkByToken(networks, token);
    if (!network) {
      audit({ event: 'auth_fail', ip });
      return err(res, 401, 'UNAUTHORIZED', 'Token does not match any configured network');
    }

    let bodyStr;
    try { bodyStr = await readBody(req); }
    catch (e) { return err(res, 413, 'BODY_TOO_LARGE', e.message); }

    let body;
    try { body = JSON.parse(bodyStr || '{}'); }
    catch (e) { return err(res, 400, 'INVALID_JSON', e.message); }

    const { from, to, message } = body;
    if (typeof from !== 'string' || !from) return err(res, 400, 'MISSING_FROM', '"from" is required');
    if (typeof to !== 'string' || !to) return err(res, 400, 'MISSING_TO', '"to" is required');
    if (typeof message !== 'string' || !message) return err(res, 400, 'MISSING_MESSAGE', '"message" is required (non-empty string)');

    const acl = checkAcl(network, from, to);
    if (!acl.ok) {
      audit({ event: 'acl_deny', ip, network: network.name, from, to, reason: acl.reason });
      return err(res, 403, 'FORBIDDEN', acl.reason);
    }

    const recipient = network.members[to];
    if (!recipient || !recipient.namespace) {
      return err(res, 500, 'BAD_CONFIG', `Member "${to}" has no "namespace" set`);
    }

    const tsStart = new Date().toISOString();
    const startMs = Date.now();
    try {
      const result = await deliverToPod(recipient.namespace, message);
      const elapsedMs = Date.now() - startMs;
      audit({
        ts: tsStart, event: 'delivered', ip,
        network: network.name, from, to,
        namespace: recipient.namespace,
        elapsedMs,
        replyLength: result.text?.length || 0,
      });
      return reply(res, 200, { ok: true, from, to, network: network.name, reply: result.text, meta: result.meta, elapsedMs });
    } catch (e) {
      const elapsedMs = Date.now() - startMs;
      audit({
        ts: tsStart, event: 'delivery_error', ip,
        network: network.name, from, to,
        namespace: recipient.namespace,
        elapsedMs,
        error: e.message,
      });
      return err(res, 502, 'DELIVERY_FAILED', e.message, { elapsedMs });
    }
  }

  // --- Network introspection ---
  // GET /networks   (auth required, lists networks visible to the caller's token)
  if (req.url === '/networks' && req.method === 'GET') {
    const token = getBearer(req);
    const network = findNetworkByToken(networks, token);
    if (!network) return err(res, 401, 'UNAUTHORIZED', 'Token does not match any configured network');
    return reply(res, 200, {
      ok: true,
      network: network.name,
      mode: network.mode,
      members: Object.keys(network.members),
      initiators: network.initiators || [],
    });
  }

  // --- Admin: clear pod cache (no auth — host-only port already restricts access) ---
  if (req.url === '/admin/clear-pod-cache' && req.method === 'POST') {
    clearPodCache();
    return reply(res, 200, { ok: true, action: 'pod-cache-cleared' });
  }

  return err(res, 404, 'NOT_FOUND', `Unknown endpoint ${req.method} ${req.url}`);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[claude-fleet-relay] listening on 0.0.0.0:${PORT}`);
  console.log(`[claude-fleet-relay] ${networkNames.length} network(s) loaded: ${networkNames.join(', ')}`);
});

process.on('SIGTERM', () => { console.log('[claude-fleet-relay] SIGTERM, exiting...'); process.exit(0); });
process.on('SIGINT',  () => { console.log('[claude-fleet-relay] SIGINT, exiting...');  process.exit(0); });
