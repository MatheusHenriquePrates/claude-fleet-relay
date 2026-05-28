<p align="center">
  <a href="#-portugu%C3%AAs"><img src="https://img.shields.io/badge/-PT--BR-39d353?style=for-the-badge&labelColor=0d1117" alt="PT-BR"/></a>
  &nbsp;
  <a href="#-english"><img src="https://img.shields.io/badge/-EN-58a6ff?style=for-the-badge&labelColor=0d1117" alt="EN"/></a>
</p>

<p align="center">
  <img src="https://capsule-render.vercel.app/api?type=slice&color=0:0d1117,100:39d353&height=180&section=header&text=claude-fleet-relay&fontSize=34&fontColor=ffffff&animation=fadeIn&fontAlignY=42&desc=relay%20HTTP%20pra%20uma%20frota%20de%20Claude%20Code%20no%20Kubernetes&descAlignY=68&descSize=14" width="100%" />
</p>

<p align="center">
  <img src="https://readme-typing-svg.demolab.com/?lines=%24+matheus%40devops%3A~%24+claude-fleet-relay;%24+rede+ACL-controlled+pra+bot+falar+com+bot;%24+entrega+via+kubectl+exec+no+pod+destino;%24+HMAC+via+Bearer+token+por+network&font=Fira%20Code&size=18&pause=1200&color=39D353&center=true&vCenter=true&width=720&height=45" />
</p>

<a id="-português"></a>

## PT-BR

```bash
matheus@devops:~$ cat sobre.txt
```

Relay HTTP pequeno que faz **bots Claude Code num cluster Kubernetes se falarem entre si**, com ACLs declarativas (quem pode iniciar call pra quem), membership de rede via token, e entrega via `kubectl exec` no pod destinatário.

Companion do [`claude-code-on-k3s`](https://github.com/MatheusHenriquePrates/claude-code-on-k3s) — os bots rodam como um Deployment por namespace, e esse relay é como eles se alcançam sem expor um Service por bot.

```bash
matheus@devops:~$ ls stack/
```

![Node.js](https://img.shields.io/badge/-Node.js-0d1117?style=for-the-badge&logo=node.js&logoColor=39d353) ![Kubernetes](https://img.shields.io/badge/-Kubernetes-0d1117?style=for-the-badge&logo=kubernetes&logoColor=39d353) ![Claude](https://img.shields.io/badge/-Claude-0d1117?style=for-the-badge&logo=anthropic&logoColor=39d353) ![kubectl](https://img.shields.io/badge/-kubectl-0d1117?style=for-the-badge&logo=kubernetes&logoColor=39d353) ![systemd](https://img.shields.io/badge/-systemd-0d1117?style=for-the-badge&logo=systemd&logoColor=39d353)

```bash
matheus@devops:~$ cat por-que-existe.txt
```

No momento que você tem dois bots Claude Code long-running no mesmo cluster, a próxima pergunta óbvia é "bot A pode perguntar algo pro bot B?". As respostas erradas que eu tentei primeiro:

- **Expor HTTP por bot.** Aí todo bot tem uma surface pública-ish, esquema de auth, story de TLS, entrada no reverse proxy. Dez bots = dez disso tudo. A personalidade dos bots não muda mas o ops burden cresce linear.
- **Pub/sub via Redis ou NATS.** Perde a forma síncrona request/response que call LLM-pra-LLM precisa (o caller espera uma resposta única, não stream de eventos).
- **Service mesh com mTLS.** Problema de 200 linhas tratado com solução de 200.000 linhas.

O que funcionou: um relay central minúsculo que:

1. Recebe `POST /send { from, to, message }` via HTTP plain.
2. Autentica o caller via Bearer token (token = membership numa "network").
3. Checa o par (from → to) contra uma ACL declarativa.
4. Entrega a mensagem no pod destinatário via `kubectl exec`, captura a resposta do bot, e devolve no HTTP response.

Surface total: um binário, um arquivo de config, um header de auth. Cada bot só sabe falar com o relay; o relay sabe achar e alcançar cada bot.

```bash
matheus@devops:~$ cat networks.txt
```

Um relay pode hospedar várias networks lado a lado. Cada network tem token próprio (vazar token de uma não afeta as outras) e um de dois modos:

- **`bidirectional`** — todo membro listado pode iniciar call pra todo outro membro listado. Usa pra relações peer.
- **`unidirectional`** — só membros em `initiators` podem disparar; o resto só pode ser chamado. Usa pra canais one-way (admin/controller pinga workers e lê resultado).

Config inteira em um JSON:

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

Tokens são referenciados por nome de env var (`token_env`) em vez de escritos no JSON. Seta o token de fato no environment (systemd `EnvironmentFile`, K8s Secret, etc.) e rotaciona rotacionando a env var.

```bash
matheus@devops:~$ cat usage.txt
```

De dentro do bot `alpha`, perguntando algo pro bot `beta`:

```bash
curl -s -X POST http://relay-host:4510/send \
  -H "Authorization: Bearer \$NET_TEAM_TOKEN" \
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

Erros comuns:

- `401 UNAUTHORIZED` — token não bate com nenhuma network.
- `403 FORBIDDEN` — par (from, to) rejeitado pela ACL. Motivos: não é membro, self-call, violação unidirectional.
- `502 DELIVERY_FAILED` — `kubectl exec` timeout, pod sumiu, ou processo do bot errou. Field `error` tem detalhe.

```bash
matheus@devops:~$ cat delivery.txt
```

O relay mantém um cache pequeno (5 min default) de `kubectl get pods -n <ns>` pra cada call não pagar o round-trip do kube-apiserver. No `/send`:

1. Resolve o namespace do destinatário pela config.
2. Resolve o namespace pra um pod name (cacheado).
3. `kubectl exec -n <ns> <pod> -c bot -- bash -c "<command>"`, onde `<command>` default é:
   ```
   claude -p '<message>' --output-format json --dangerously-skip-permissions
   ```
4. Captura stdout. Se parsear como JSON, expõe `result` e `session_id`. Senão passa o texto raw.

Override do template via env var:

```bash
DELIVERY_COMMAND_TEMPLATE="my-bot-cli inject --stdin <<< '__MESSAGE__'" \
node relay.mjs
```

```bash
matheus@devops:~$ cat acl-semantics.txt
```

|  | Bidirectional | Unidirectional |
|---|---|---|
| Self-call (`from == to`) | Rejeitado | Rejeitado |
| Membro chama o outro | Permitido | Só se `from ∈ initiators` |
| Não-membro chama membro | Rejeitado | Rejeitado |
| Membro de uma network chama membro de outra (mesmo relay) | Rejeitado (token diferente) | Rejeitado |

O token É a claim de membership. Quem tem o token da network pode assumir qualquer `from` que seja membro — **não tem identity check secundário**. É deliberado (é relay, não IdP), mas significa: **trata token de cada network como secret compartilhado entre TODOS os membros**.

```bash
matheus@devops:~$ ./quick-start.sh
```

```bash
git clone https://github.com/MatheusHenriquePrates/claude-fleet-relay
cd claude-fleet-relay
npm install
cp .env.example .env
cp config/networks.example.json config/networks.json

# Gera tokens
echo "NET_TEAM_TOKEN=\$(openssl rand -hex 32)" >> .env
echo "NET_ADMIN_TO_WORKERS_TOKEN=\$(openssl rand -hex 32)" >> .env

# Edita config/networks.json pra casar com sua frota
\$EDITOR config/networks.json

# Start
node relay.mjs

# Smoke test
curl http://127.0.0.1:4510/health
```

Pra produção, veja `systemd/claude-fleet-relay.service` — unit systemd que roda como user não-privilegiado com `ProtectSystem=strict`.

```bash
matheus@devops:~$ ls endpoints/
```

| Endpoint | Método | Auth | Pra quê |
|---|---|---|---|
| `/` | GET | não | Banner + lista de network names |
| `/health` | GET | não | Igual ao `/` (healthcheck) |
| `/networks` | GET | sim | Members e mode da network dona do bearer token |
| `/send` | POST | sim | Entrega mensagem: `{ from, to, message }` |
| `/admin/clear-pod-cache` | POST | não | Força re-discovery dos pod names (sem auth — restringe a porta em vez) |

```bash
matheus@devops:~$ cat onde-deployar.txt
```

Três escolhas, em ordem crescente de isolamento:

1. **Como processo no host** (systemd) no node do control plane K8s. Chama `kubectl` direto contra o kubeconfig local. Mais simples, menor blast radius — ele só pode o que o kubeconfig dele permite. **É o que a unit systemd assume.**
2. **Como Pod** com ServiceAccount de Role mínima (`get pods`, `exec pods` nos namespaces relevantes). Mais portável, mais difícil de fechar com precisão.
3. **Como sidecar de cada bot.** Não faz isso — derrota o sentido de ter trust boundary central.

```bash
matheus@devops:~$ cat o-que-NAO-e.txt
```

- **Não é identity provider.** Token é membership de network. Se token de um bot vaza, rotaciona o da network toda e atualiza todos os membros.
- **Não é fila.** Calls são síncronos. Recipient lento bloqueia o caller até `DELIVERY_TIMEOUT_MS` (default 60s).
- **Não é router com retries.** Uma call = uma tentativa. Recipient up ou 502 rápido.
- **Não é mesh.** Sem mTLS service-to-service, sem observability layer.
- **Não é jeito de chamar fora do cluster.** Todos os destinos precisam ser namespaces que o kubeconfig do relay alcança.

```bash
matheus@devops:~$ cat LICENSE
```

MIT. Veja [LICENSE](LICENSE).

```bash
matheus@devops:~$ contact
```

[![LinkedIn](https://img.shields.io/badge/-LinkedIn-0d1117?style=for-the-badge&logo=linkedin&logoColor=39d353)](https://www.linkedin.com/in/matheus-henrique-prates-586328234/)
[![Email](https://img.shields.io/badge/-Email-0d1117?style=for-the-badge&logo=gmail&logoColor=39d353)](mailto:mathues12398henrique@gmail.com)

```bash
matheus@devops:~$ _
```

---

<a id="-english"></a>

## EN

```bash
matheus@devops:~$ cat about.txt
```

A small HTTP relay that lets **Claude Code bots in a Kubernetes cluster talk to each other**, with declarative ACLs (who can initiate a call to whom), token-based network membership, and delivery via `kubectl exec` into the recipient pod.

Designed as the companion to [`claude-code-on-k3s`](https://github.com/MatheusHenriquePrates/claude-code-on-k3s) — the bots run as one Deployment per namespace, and this relay is how they reach each other without exposing a Service per bot.

```bash
matheus@devops:~$ ls stack/
```

![Node.js](https://img.shields.io/badge/-Node.js-0d1117?style=for-the-badge&logo=node.js&logoColor=39d353) ![Kubernetes](https://img.shields.io/badge/-Kubernetes-0d1117?style=for-the-badge&logo=kubernetes&logoColor=39d353) ![Claude](https://img.shields.io/badge/-Claude-0d1117?style=for-the-badge&logo=anthropic&logoColor=39d353) ![kubectl](https://img.shields.io/badge/-kubectl-0d1117?style=for-the-badge&logo=kubernetes&logoColor=39d353) ![systemd](https://img.shields.io/badge/-systemd-0d1117?style=for-the-badge&logo=systemd&logoColor=39d353)

```bash
matheus@devops:~$ cat networks.txt
```

A relay can host multiple networks side by side. Each network has its own token and one of two modes:

- **`bidirectional`** — every listed member can initiate a call to every other listed member.
- **`unidirectional`** — only members in `initiators` can call out.

Config:

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
    }
  }
}
```

```bash
matheus@devops:~$ cat usage.txt
```

```bash
curl -s -X POST http://relay-host:4510/send \
  -H "Authorization: Bearer \$NET_TEAM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"from":"alpha","to":"beta","message":"hey, can you summarize today?"}'
```

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

```bash
matheus@devops:~$ cat acl-semantics.txt
```

|  | Bidirectional | Unidirectional |
|---|---|---|
| Self-call (`from == to`) | Rejected | Rejected |
| Either member calls the other | Allowed | Only if `from ∈ initiators` |
| Non-member calls a member | Rejected | Rejected |
| Member of one network calls a member of another | Rejected | Rejected |

The token IS the membership claim. There is **no secondary identity check**. Treat each network's token as a shared secret among ALL its members.

```bash
matheus@devops:~$ ./quick-start.sh
```

```bash
git clone https://github.com/MatheusHenriquePrates/claude-fleet-relay
cd claude-fleet-relay
npm install
cp .env.example .env
cp config/networks.example.json config/networks.json

echo "NET_TEAM_TOKEN=\$(openssl rand -hex 32)" >> .env

node relay.mjs
curl http://127.0.0.1:4510/health
```

```bash
matheus@devops:~$ cat what-this-is-NOT.txt
```

- **Not an identity provider.** Token is the network membership. If a bot's token leaks, rotate the network's token.
- **Not a queue.** Calls are synchronous; slow recipient blocks the caller until `DELIVERY_TIMEOUT_MS` (default 60s).
- **Not a router with retries.** One call = one attempt.
- **Not a mesh.** No service-to-service mTLS.
- **Not a way to call out of the cluster.** All recipients must be K8s namespaces the relay's kubeconfig can reach.

```bash
matheus@devops:~$ cat LICENSE
```

MIT. See [LICENSE](LICENSE).

```bash
matheus@devops:~$ contact
```

[![LinkedIn](https://img.shields.io/badge/-LinkedIn-0d1117?style=for-the-badge&logo=linkedin&logoColor=39d353)](https://www.linkedin.com/in/matheus-henrique-prates-586328234/) [![Email](https://img.shields.io/badge/-Email-0d1117?style=for-the-badge&logo=gmail&logoColor=39d353)](mailto:mathues12398henrique@gmail.com)

```bash
matheus@devops:~$ _
```

<p align="center">
  <img src="https://capsule-render.vercel.app/api?type=waving&color=0:39d353,100:0d1117&height=120&section=footer" width="100%" />
</p>
