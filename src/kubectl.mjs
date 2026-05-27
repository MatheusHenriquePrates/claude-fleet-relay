import { execFile } from 'node:child_process';

/**
 * Thin wrapper around `kubectl` for two operations:
 *
 *   1. Resolve a namespace to the name of the first pod inside it (with caching).
 *   2. Run `kubectl exec` to deliver a message to that pod's bot process.
 *
 * Message delivery shells into the pod and pipes the message through
 * whatever STDIN handler the bot has wired up. The exact wire protocol
 * (a shell command, a named pipe, an HTTP call to a sidecar...) is left
 * to the operator — `DELIVERY_COMMAND_TEMPLATE` is parametrized.
 *
 * Default template invokes `claude -p '<MSG>'` directly. Override via
 * env var if your bot consumes messages differently.
 */

const POD_CACHE_TTL_MS = parseInt(process.env.POD_CACHE_TTL_MS || '300000', 10);
const DELIVERY_TIMEOUT_MS = parseInt(process.env.DELIVERY_TIMEOUT_MS || '60000', 10);
const DELIVERY_COMMAND_TEMPLATE = process.env.DELIVERY_COMMAND_TEMPLATE
  || `claude -p '__MESSAGE__' --output-format json --dangerously-skip-permissions`;
const DELIVERY_CONTAINER = process.env.DELIVERY_CONTAINER || 'bot';
const KUBECTL_BIN = process.env.KUBECTL_BIN || 'kubectl';

const podCache = new Map();

function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10_000, maxBuffer: 10 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.toString().trim().slice(-500) || err.message));
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

export async function getPodName(namespace) {
  const cached = podCache.get(namespace);
  if (cached && Date.now() - cached.ts < POD_CACHE_TTL_MS) return cached.name;

  const { stdout } = await execFileP(KUBECTL_BIN, [
    'get', 'pods',
    '-n', namespace,
    '-o', 'jsonpath={.items[0].metadata.name}',
  ]);
  const name = stdout.trim();
  if (!name) throw new Error(`No pods in namespace "${namespace}"`);
  podCache.set(namespace, { name, ts: Date.now() });
  return name;
}

export async function deliverToPod(namespace, message) {
  const podName = await getPodName(namespace);

  // Single-quote escape: ' -> '\''
  const escapedMsg = message.replace(/'/g, "'\\''");
  const command = DELIVERY_COMMAND_TEMPLATE.replace('__MESSAGE__', escapedMsg);

  const { stdout } = await execFileP(KUBECTL_BIN, [
    'exec',
    '-n', namespace,
    podName,
    '-c', DELIVERY_CONTAINER,
    '--',
    'bash', '-c', command,
  ], { timeout: DELIVERY_TIMEOUT_MS + 10_000 });

  // If the bot returned JSON (default --output-format json), pass it through.
  // Otherwise return the raw text.
  try {
    const parsed = JSON.parse(stdout);
    return { text: parsed.result || stdout.trim(), meta: { session_id: parsed.session_id } };
  } catch {
    return { text: stdout.trim(), meta: {} };
  }
}

export function clearPodCache() {
  podCache.clear();
}
