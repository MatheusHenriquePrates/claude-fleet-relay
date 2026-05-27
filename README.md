# claude-fleet-relay

A small HTTP relay that lets **Claude Code bots in a Kubernetes cluster talk to each other**, with declarative ACLs (who can initiate a call to whom), token-based network membership, and delivery via `kubectl exec` into the recipient pod.

Designed as the companion to [`claude-code-on-k3s`](https://github.com/MatheusHenriquePrates/claude-code-on-k3s) — the bots run as one Deployment per namespace, and this relay is how they reach each other without exposing a Service per bot.

## Why this exists

The moment you have two long-running Claude Code bots in the same cluster, the next obvious question is "can bot A ask bot B something?" The wrong answers I tried first:

- **Expose HTTP per bot.** Now every bot has a public-ish surface, an authentication scheme, a TLS story, and a reverse proxy entry. Ten bots = ten of all those. The personalities of the bots don't change but the ops burden grows linearly.
- **Pub/sub through Redis or NATS.** Loses the synchronous request/response shape that LLM-to-LLM calls actually need (the caller is waiting for a single answer, not a stream of events).
- **Service mesh with mTLS.** A 200-line problem treated with a 200,000-line solution.

What worked: one tiny central relay that:

1. Receives `POST /send { from, to, message }` over plain HTTP.
2. Authenticates the caller via Bearer token (token = membership in a "network").
3. Checks the (from → to) pair against a declarative ACL.
4. Delivers the message into the recipient pod by `kubectl exec`, captures the bot's reply, and returns it in the HTTP response.

Total surface: one binary, one config file, one auth header. Each bot only knows how to talk to the relay; the relay knows how to find and reach each bot.

## What's a "network"?

A relay can host multiple networks side by side. Each network has its own token (so leaking one network's token doesn't affect the others) and one of two modes:

- **`bidirectional`** — every listed member can initiate a call to every other listed member.
  Use for peer relationships: a team of bots that all see each other as equals.
- **`unidirectional`** — only members in `initiators` can call out; the rest can only be called.
  Use for one-way command channels: an "admin" or "controller" bot that pings workers and reads back results, but workers can't ping each other or the controller.

The full config is one JSON file:

```json
{
  "networks": {
    "team": {
      "mode": "bidirectional",
      "token_env": "NET_TEAM_TOKEN",
      "members": {
        "alpha": { "namespace": "claude-code-alpha" },
        "beta":  { "namespace": "claude-code-beta" },
        "gamma": { "namespace": "claude-code-gamma" }
      }
    },
    "admin-to-workers": {
      "mode": "unidirectional",
      "token_env": "NET_ADMIN_TO_WORKERS_TOKEN",
      "initiators": ["admin"],
      "members": {
        "admin":    { "namespace": "claude-code-admin" },
        "worker-1": { "namespace": "claude-code-worker-1" },
        "worker-2": { "namespace": "claude-code-worker-2" }
      }
    }
  }
}
```

Tokens are referenced by env var name (`token_env`) rather than written into the JSON. Set the actual token in the environment (systemd `EnvironmentFile`, Kubernetes Secret, etc.) and rotate by rotating the env var.

## Calling the relay

From inside bot `alpha`, asking bot `beta` something:

```bash
curl -s -X POST http://relay-host:4510/send \
  -H "Authorization: Bearer $NET_TEAM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"from":"alpha","to":"beta","message":"hey, can you summarize today?"}'
```

Response:

```json
{
  "ok": true,
  "from": "alpha",
  "to": "beta",
  "network": "team",
  "reply": "Sure — today we shipped 3 PRs and merged 2 of mine.",
  "meta": { "session_id": "..." },
  "elapsedMs": 4231
}
```

Common error responses:

- `401 UNAUTHORIZED` — token doesn't match any network.
- `403 FORBIDDEN` — the (from, to) pair is rejected by the network's ACL. Reasons: not a member, self-call, unidirectional violation.
- `502 DELIVERY_FAILED` — `kubectl exec` timed out, the pod was gone, or the bot's process errored out. The `error` field has details.

## How delivery actually happens

The relay holds a small cache (5 min default) of `kubectl get pods -n <ns>` results so each call doesn't pay the kube-apiserver round-trip. On `/send`:

1. Look up the recipient's namespace from the network config.
2. Resolve the namespace to a pod name (cached).
3. `kubectl exec -n <ns> <pod> -c bot -- bash -c "<command>"` where `<command>` defaults to:
   ```
   claude -p '<message>' --output-format json --dangerously-skip-permissions
   ```
   `__MESSAGE__` is replaced by the escaped message, single-quoted to survive shell parsing.
4. Capture stdout. If it parses as JSON (because of `--output-format json`), surface `result` and `session_id`. Otherwise pass through the raw text.

Override the delivery template via env var:

```bash
DELIVERY_COMMAND_TEMPLATE="my-bot-cli inject --stdin <<< '__MESSAGE__'" \
  node relay.mjs
```

You can also override `DELIVERY_CONTAINER` (default `bot`) if your pod has multiple containers.

## ACL semantics

| | Bidirectional | Unidirectional |
|---|---|---|
| Self-call (`from == to`) | Rejected | Rejected |
| Either member calls the other | Allowed | Only if `from ∈ initiators` |
| Non-member calls a member | Rejected | Rejected |
| Member of one network calls a member of another (same relay) | Rejected (cross-network = different token) | Rejected |

The token IS the membership claim. If you have the network's token, you can assume any `from` that's a member of that network — there is **no secondary identity check**. This is deliberate (it's a relay, not an identity provider), but it means: **treat each network's token as a shared secret among ALL its members**. Don't grant a token to bot A and assume bot A can only send `from: A`.

If you need per-bot identity, give each bot its own network (mode: unidirectional, one initiator, one recipient) and one token per pair. Verbose, but correct.

## Quick start

```bash
git clone https://github.com/MatheusHenriquePrates/claude-fleet-relay
cd claude-fleet-relay
npm install
cp .env.example .env
cp config/networks.example.json config/networks.json

# Generate tokens
echo "NET_TEAM_TOKEN=$(openssl rand -hex 32)" >> .env
echo "NET_ADMIN_TO_WORKERS_TOKEN=$(openssl rand -hex 32)" >> .env

# Edit config/networks.json to match your fleet
$EDITOR config/networks.json

# Start the relay
node relay.mjs

# In another terminal, smoke test:
curl http://127.0.0.1:4510/health
```

For production, see `systemd/claude-fleet-relay.service` for a systemd unit that runs the relay as a non-privileged user with `ProtectSystem=strict`.

## Endpoints

| Endpoint | Method | Auth | What |
|---|---|---|---|
| `/` | GET | no | Banner + list of network names |
| `/health` | GET | no | Same as `/` (for healthchecks) |
| `/networks` | GET | yes | Members and mode of the network owning the bearer token |
| `/send` | POST | yes | Deliver a message: `{ from, to, message }` |
| `/admin/clear-pod-cache` | POST | no | Force re-discovery of pod names (no auth — restrict the port instead) |

`/admin/clear-pod-cache` does not require auth because the assumption is the port is bound to `127.0.0.1` or behind a firewall. If you expose the relay publicly, put a reverse proxy in front and block `/admin/*`.

## Where to deploy the relay

You have three choices, in increasing isolation:

1. **As a host process** (systemd) on the K8s control plane node. Calls `kubectl` directly against the local kubeconfig. Simplest, lowest blast radius if the relay is compromised — it can only do what its host kubeconfig allows. **This is what the systemd unit assumes.**
2. **As a Pod** with a ServiceAccount that has minimum-grant Role (`get pods`, `exec pods` in the relevant namespaces). More portable, harder to lock down precisely.
3. **As a sidecar of each bot.** Don't do this — defeats the point of having a central trust boundary.

For options 1 and 2, the relay's "identity" toward Kubernetes is whatever credential it picks up. Audit accordingly.

## What this is NOT

- **Not an identity provider.** The token is the network membership. No JWT, no per-bot identity, no replay protection beyond TLS-at-the-front. If a bot's token leaks, rotate the network's token and update all members.
- **Not a queue.** Calls are synchronous. If the recipient is slow, the caller blocks until `DELIVERY_TIMEOUT_MS` (default 60s). If you need async/queued delivery, route through a message broker after the relay.
- **Not a router with retries.** One call = one delivery attempt. The relay assumes the recipient is up or returns a 502 fast.
- **Not a mesh.** No service-to-service mTLS, no observability layer, no traffic shifting. If you need those, you need a service mesh, not a relay.
- **Not a way to call out of the cluster.** All recipients must be K8s namespaces that the relay's kubeconfig can reach. To bridge external systems, write a "shim bot" pod that does the outbound call.

## License

MIT. See [LICENSE](LICENSE).
