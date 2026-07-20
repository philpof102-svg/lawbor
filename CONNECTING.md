# Testing LAWBOR across two machines

LAWBOR is decentralized: each machine runs its own node and they talk directly. Here is how to bring
two nodes up on a LAN (two PCs on the same Wi-Fi / router) and watch a message cross between them.

> **Why the extra flags?** A production node refuses private/LAN addresses on purpose (that is the
> SSRF protection). For a LAN test you opt into `LAWBOR_ALLOW_PRIVATE=1` (allows `192.168.x` / `10.x`
> — but **never** cloud-metadata `169.254.169.254`) and `LAWBOR_ALLOW_INSECURE=1` (plain `http` on the
> LAN). These are development flags; never set them on a public node.

## 0. Both machines: get LAWBOR + node ≥ 18

```bash
git clone https://github.com/philpof102-svg/lawbor && cd lawbor
npm install              # the core needs nothing; this pulls viem, the OPTIONAL signature verifier
node --version            # 18+
npm test                 # optional, but this is what 'it works' means here
```

Find each machine's LAN IP:
- Windows: `ipconfig` → "IPv4 Address" (e.g. `192.168.1.20`)
- macOS/Linux: `ipconfig getifaddr en0` or `hostname -I`

Call them **PC-A = 192.168.1.20** and **PC-B = 192.168.1.21** below (use your real IPs).

## 1. One machine: run the permissive test oracle

Real nodes gate everyone against MainStreet, so test addresses would be dropped. The stub oracle makes
every address pass, so you can test the *mechanics*. Run it once (say on PC-A):

```bash
PORT=4899 node sim/oracle.js          # prints: LAWBOR test oracle (PERMISSIVE) on :4899 — TEST ONLY
```

Both nodes will point at `http://192.168.1.20:4899`. (Skip this step and drop `MAINSTREET_URL` if you
use addresses that already have a real MainStreet score ≥ 40.)

## 1b. Give each node a signer — otherwise nothing will arrive

**This step is new, and without it the rest of this guide silently fails.** A node with `viem` installed
authenticates every inbound envelope, so two nodes that cannot sign will refuse each other. You will see
`delivered:false` and an empty `/requests`, with this reason on the receiving side:

```
envelope carries no signature — `from` would be an unverified claim
```

LAWBOR never holds a key, so it cannot sign for you. Point it at **a module you wrote**:

```bash
cp examples/signer-viem.js ./my-signer.js
export MY_TEST_KEY=0x<your own 32-byte throwaway key>   # EACH NODE NEEDS ITS OWN
export LAWBOR_SIGNER=./my-signer.js
```

⚠️ **Every node needs a DIFFERENT key.** The example falls back to a hardcoded `0x1111…` key, so two
operators who both copy it end up speaking as the SAME address — and every envelope is then refused as
impersonation, which reads exactly like a mysterious network failure. Set `MY_TEST_KEY` on each node, and
set that node's `LAWBOR_ADDR` to the matching address (the example exposes it as `module.exports.address`).

**Running two nodes on ONE machine?** Give each its own message store, or they silently share
`data/messages.jsonl` and each folds the other's traffic as its own:

```bash
LAWBOR_DB=/tmp/lawbor-a.jsonl LAWBOR_CONTROL=/tmp/lawbor-a.control   # node A
LAWBOR_DB=/tmp/lawbor-b.jsonl LAWBOR_CONTROL=/tmp/lawbor-b.control   # node B
LAWBOR_ALLOW_LOOPBACK=1                                              # 127.0.0.1 peering needs this
```

`LAWBOR_DATA_DIR` does **not** do this — it only steers the txfacts cache.

The node calls that module with the EIP-712 payload and expects a `0x` signature back. What happens in
between is yours — a wallet, a KMS, a hardware device. There is deliberately **no `LAWBOR_PRIVATE_KEY`**:
an env var we read would make us the custodian of your key, which is the one thing this project promises
never to be. A signer path that does not load **refuses to start** rather than booting unsigned.

The address your signer speaks as MUST equal that node's `LAWBOR_ADDR`. A valid signature by a different
key is still refused — that is the impersonation gate working, and it looks exactly like a config typo.
Check `GET /health`: you want `originatesSigned: true` **and** `authenticatesSenders: true`.

> **Testing the mechanics only?** Set `LAWBOR_ALLOW_UNAUTHENTICATED=1` on **both** nodes instead. Then
> `from` is an unverified claim anyone can type, and any address's reputation can be worn by anyone.
> Fine for a LAN demo of the plumbing, never for anything reachable.

## 2. Start a node on each machine

**PC-A** (address ending `…aaaa`):
```bash
LAWBOR_ADDR=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
LAWBOR_HUMAN=alice \
MAINSTREET_URL=http://192.168.1.20:4899 \
LAWBOR_ALLOW_PRIVATE=1 LAWBOR_ALLOW_INSECURE=1 \
PORT=4830 node server.js
```

**PC-B** (address ending `…bbbb`):
```bash
LAWBOR_ADDR=0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
LAWBOR_HUMAN=bob \
MAINSTREET_URL=http://192.168.1.20:4899 \
LAWBOR_ALLOW_PRIVATE=1 LAWBOR_ALLOW_INSECURE=1 \
PORT=4830 node server.js
```

## 3. Peer them (each learns the other's address → URL)

```bash
# on PC-A. NOTE THE 127.0.0.1: every operator-gated route (/peers /say /accept /work /block) trusts
# ONLY loopback. Curling your OWN LAN IP is a REMOTE caller and answers 401 — this guide said
# 192.168.x here for weeks and every reader hit that wall on the first write.
curl -X POST http://127.0.0.1:4830/peers -H content-type:application/json \
  -d '{"addr":"0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","url":"http://192.168.1.21:4830"}'

# on PC-B, same rule — the URL you POST TO is loopback, the url you POST ABOUT is the LAN one
curl -X POST http://127.0.0.1:4830/peers -H content-type:application/json \
  -d '{"addr":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","url":"http://192.168.1.20:4830"}'
```

Each `/peers` call fetches the other node's discovery card, checks it matches, and reputation-gates it.
A `{"ok":true}` means the peer was admitted. `curl http://<ip>:4830/health` shows the peer count.

## 4. Send a message and watch it arrive

```bash
# Alice (PC-A) messages Bob — again loopback, it is an operator route
curl -X POST http://127.0.0.1:4830/say -H content-type:application/json \
  -d '{"to":"0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","body":"gm bob, from another machine"}'

# On Bob (PC-B): first contact from a stranger lands in REQUESTS, not the inbox
curl http://127.0.0.1:4830/requests
# accept Alice, and it moves to Bob's inbox:
curl -X POST http://127.0.0.1:4830/accept -H content-type:application/json \
  -d '{"addr":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
curl http://127.0.0.1:4830/inbox
```

You are now watching the full stack across two machines: reputation admission, the consent quarantine,
accept → inbox. Post a job (`/work`), block an address (`/block`) — every route in `README.md` works.

## 5. Watch it in the floating pod (optional)

On either machine, attach the desktop pod to its local node:
```bash
npm i -D electron          # once
LAWBOR_NODE_URL=http://127.0.0.1:4830 LAWBOR_VIEW=requests npm run desktop
```

## Use LAWBOR from openclaude (or Claude Code)

LAWBOR ships a stdio MCP server (the `lawbor-bot` package), so any MCP-speaking agent — [openclaude](https://openclaude.gitlawb.com/), Claude Code, Claude Desktop — can load its 25 tools (`lawbor_bazaar`, `lawbor_offer`, `lawbor_quote`, `lawbor_confirm`, `lawbor_settle`, `lawbor_peer`, `lawbor_credit`, …) straight into its agent loop.

```bash
# macOS / Linux
openclaude mcp add lawbor -- npx -y lawbor-bot

# Windows: npx is not directly spawnable — wrap it in cmd /c (install once so the spawn is instant)
npm i -g lawbor-bot
openclaude mcp add lawbor -- cmd /c lawbor-mcp
```

Verify the agent actually connected and discovered the tools — no model/API key needed:

```bash
openclaude mcp doctor lawbor        # → "Live check: connected", 1 healthy, 0 blocking
```

Same JSON works for Claude Code / Claude Desktop (`mcpServers.lawbor`). The server is **descriptor-only**: it holds no key and signs nothing, so an agent using these tools negotiates and settles by returning EIP-712 descriptors its own wallet signs — it can never move your funds.

## Troubleshooting

- **`connection timed out` when an MCP client spawns `lawbor`** → on Windows use `cmd /c lawbor-mcp` (see above), and install `lawbor-bot` globally first so the first spawn doesn't wait on an `npx` download.
- **`/peers` returns `ok:false, reason: private / ... refused`** → you forgot `LAWBOR_ALLOW_PRIVATE=1`
  on the node you POSTed to.
- **`discovery card unreachable`** → a firewall is blocking port 4830. Allow it, or check the IP.
- **Message dropped / not in requests** → the sender's address scored below 40. Use the stub oracle
  (step 1), or an address with a real MainStreet score.
- **`delivered:false` and `/requests` stays empty** → neither node has a signer. See step 1b: the
  receiver refuses unsigned envelopes with "envelope carries no signature". `delivered` now means A PEER
  ACCEPTED IT, not "we tried" — `delivered:null` means the transport could not tell us either way.
- **Node exits at boot with `LAWBOR_SIGNER=… could not be loaded`** → the path is wrong. Deliberate: a
  node that booted unsigned while you believed it was signing would look identical to success.
- **Every envelope refused as impersonation** → your signer's address ≠ that node's `LAWBOR_ADDR`.
- **`169.254.*` refused even with `LAWBOR_ALLOW_PRIVATE`** → intentional. Link-local / cloud metadata
  is never opened; it is the SSRF target that matters.
