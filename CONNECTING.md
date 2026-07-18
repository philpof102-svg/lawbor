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
node --version            # 18+  (LAWBOR has zero npm dependencies — nothing to install)
npm test                 # optional: 156 checks should pass
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
# on PC-A, tell it where Bob is:
curl -X POST http://192.168.1.20:4830/peers -H content-type:application/json \
  -d '{"addr":"0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","url":"http://192.168.1.21:4830"}'

# on PC-B, tell it where Alice is:
curl -X POST http://192.168.1.21:4830/peers -H content-type:application/json \
  -d '{"addr":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","url":"http://192.168.1.20:4830"}'
```

Each `/peers` call fetches the other node's discovery card, checks it matches, and reputation-gates it.
A `{"ok":true}` means the peer was admitted. `curl http://<ip>:4830/health` shows the peer count.

## 4. Send a message and watch it arrive

```bash
# Alice (PC-A) messages Bob:
curl -X POST http://192.168.1.20:4830/say -H content-type:application/json \
  -d '{"to":"0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","body":"gm bob, from another machine"}'

# On Bob (PC-B): first contact from a stranger lands in REQUESTS, not the inbox
curl http://192.168.1.21:4830/requests
# accept Alice, and it moves to Bob's inbox:
curl -X POST http://192.168.1.21:4830/accept -H content-type:application/json \
  -d '{"addr":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
curl http://192.168.1.21:4830/inbox
```

You are now watching the full stack across two machines: reputation admission, the consent quarantine,
accept → inbox. Post a job (`/work`), block an address (`/block`) — every route in `README.md` works.

## 5. Watch it in the floating pod (optional)

On either machine, attach the desktop pod to its local node:
```bash
npm i -D electron          # once
LAWBOR_NODE_URL=http://127.0.0.1:4830 LAWBOR_VIEW=requests npm run desktop
```

## Troubleshooting

- **`/peers` returns `ok:false, reason: private / ... refused`** → you forgot `LAWBOR_ALLOW_PRIVATE=1`
  on the node you POSTed to.
- **`discovery card unreachable`** → a firewall is blocking port 4830. Allow it, or check the IP.
- **Message dropped / not in requests** → the sender's address scored below 40. Use the stub oracle
  (step 1), or an address with a real MainStreet score.
- **`169.254.*` refused even with `LAWBOR_ALLOW_PRIVATE`** → intentional. Link-local / cloud metadata
  is never opened; it is the SSRF target that matters.
