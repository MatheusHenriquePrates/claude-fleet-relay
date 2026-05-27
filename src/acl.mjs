/**
 * Access-control logic for inter-bot calls.
 *
 * A network is one of two modes:
 *   - bidirectional: any member can initiate to any other member
 *   - unidirectional: only members listed in `initiators` can initiate;
 *                     everyone else can only be a recipient
 *
 * The relay must reject any call where the (from, to) pair is not allowed
 * by the network the token resolves to. This is enforced server-side
 * even though clients usually know the rules, because clients are bots
 * and bots make mistakes.
 */

export function findNetworkByToken(networks, token) {
  if (!token) return null;
  for (const [name, net] of Object.entries(networks)) {
    if (net.token && net.token === token) {
      return { name, ...net };
    }
  }
  return null;
}

export function checkAcl(network, fromId, toId) {
  if (!network) return { ok: false, reason: 'no network' };
  const fromMember = network.members[fromId];
  const toMember = network.members[toId];
  if (!fromMember) return { ok: false, reason: `from "${fromId}" is not a member of network "${network.name}"` };
  if (!toMember) return { ok: false, reason: `to "${toId}" is not a member of network "${network.name}"` };
  if (fromId === toId) return { ok: false, reason: 'self-call not allowed' };

  if (network.mode === 'bidirectional') {
    return { ok: true };
  }

  if (network.mode === 'unidirectional') {
    const initiators = network.initiators || [];
    if (!initiators.includes(fromId)) {
      return { ok: false, reason: `"${fromId}" is not an initiator in unidirectional network "${network.name}"` };
    }
    return { ok: true };
  }

  return { ok: false, reason: `unknown mode "${network.mode}"` };
}
