import fs from 'node:fs';

/**
 * Load networks.json. Each network references its HMAC token by env var name
 * (token_env) so secrets never sit in the JSON file.
 *
 * The loader resolves token_env into the actual token at load time and
 * stores it as network.token, used for membership lookup by `findNetworkByToken`.
 */
export function loadNetworks(configPath) {
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw);
  const declared = parsed.networks || {};

  const networks = {};
  for (const [name, decl] of Object.entries(declared)) {
    const mode = decl.mode;
    if (mode !== 'bidirectional' && mode !== 'unidirectional') {
      throw new Error(`Network "${name}": invalid mode "${mode}". Use "bidirectional" or "unidirectional".`);
    }
    if (mode === 'unidirectional' && (!decl.initiators || decl.initiators.length === 0)) {
      throw new Error(`Network "${name}": unidirectional mode requires non-empty "initiators" array.`);
    }

    const tokenEnvVar = decl.token_env;
    if (!tokenEnvVar) {
      throw new Error(`Network "${name}": missing token_env (name of env var holding the HMAC token).`);
    }
    const token = process.env[tokenEnvVar];
    if (!token) {
      throw new Error(`Network "${name}": env var ${tokenEnvVar} is not set.`);
    }

    const members = decl.members || {};
    if (Object.keys(members).length < 2) {
      throw new Error(`Network "${name}": at least 2 members required.`);
    }

    networks[name] = {
      mode,
      token,
      initiators: decl.initiators || [],
      members,
    };
  }

  return networks;
}
