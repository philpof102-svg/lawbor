#!/usr/bin/env bash
# Publish LAWBOR to gitlawb — the decentralized git network its trust ideas belong to. MIT.
# ==================================================================================================
# LAWBOR is the reputation layer for agents; gitlawb's ecosystem (Kevin's) is exactly where that wedge
# fits — so its code should live on gitlawb too, under your DID, alongside Toshi.
#
# ⚠️ Linux/macOS ONLY (the gl CLI has no Windows build — on Windows run this inside WSL:
#    `wsl bash tools/publish-gitlawb.sh`). Idempotent: re-running re-registers (safe) and force-updates
#    the mirror. It REUSES your existing DID (the same identity that already published Toshi), so if you
#    cleared the iCaptcha once for that DID, this will NOT ask again — registration is per-identity.
#
# Steps (all the documented gitlawb.com/start flow):
#   1. put the REAL linux gl on PATH (npm) — a stale Windows `gl` shim inherited into WSL silently
#      shadows it and breaks every push; point git-remote-gitlawb at the public node (GITLAWB_NODE)
#   2. reuse the DID identity (~/.gitlawb/identity.pem — BACK IT UP, it IS the account)
#   3. register with the node — STOP LOUDLY if it demands an iCaptcha (that human step can't be scripted)
#   4. mirror THIS repo's public GitHub history into gitlawb://<your-did>/lawbor via `gl mirror`
set -euo pipefail

NODE_URL="${GITLAWB_NODE:-https://node.gitlawb.com}"
export GITLAWB_NODE="$NODE_URL"
GITHUB_URL="${LAWBOR_GITHUB_URL:-https://github.com/philpof102-svg/lawbor}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
echo "· lawbor repo:  $REPO_DIR"
echo "· gitlawb node: $NODE_URL"
echo "· github src:   $GITHUB_URL"

# 1. gl CLI — the real linux binary MUST win over any C:\...\npm\gl shim WSL inherits on PATH.
NPM_BIN="$(npm config get prefix 2>/dev/null)/bin"
export PATH="$NPM_BIN:$PATH"
if ! gl --version >/dev/null 2>&1; then
  echo "· installing @gitlawb/gl via npm…"
  npm i -g @gitlawb/gl
fi
echo "· gl: $(command -v gl) ($(gl --version)) · helper: $(command -v git-remote-gitlawb || echo MISSING)"

# 2. identity (NEVER overwrite an existing one — that key IS the account/URL, reused across Toshi + LAWBOR)
if gl identity show >/dev/null 2>&1; then
  echo "· identity exists (reused): $(gl identity show)"
else
  echo "· creating a new DID identity (saved to ~/.gitlawb/identity.pem — BACK THIS FILE UP)"
  gl identity new
fi
MY_DID="$(gl identity show)"

# 3. register with the node. The public node can require an iCaptcha proof (level ≥ 3) — a human
#    challenge we must NOT bypass. If already cleared for this DID (e.g. via Toshi), this just continues.
echo "· registering $MY_DID with $NODE_URL …"
if ! reg_out="$(gl register 2>&1)"; then
  echo "$reg_out"
  if echo "$reg_out" | grep -qi "icaptcha\|captcha\|proof required\|403"; then
    cat <<EOF

⛔ gitlawb registration needs a human iCaptcha proof — this script cannot (and must not) solve it.
   Do this ONE step, then re-run this script:

     export PATH="$NPM_BIN:\$PATH"
     export GITLAWB_NODE=$NODE_URL
     gl quickstart          # guided: solves the iCaptcha, registers this DID, reuses your key

   (or follow the challenge URL gl printed above and register manually.)
EOF
    exit 2
  fi
  echo "· register returned non-zero (often = already registered) — continuing"
fi

# 4. mirror the CURRENT GitHub history into gitlawb (pulls master straight from GitHub). Idempotent.
echo "· mirroring $GITHUB_URL → gitlawb://$MY_DID/lawbor …"
gl mirror "$GITHUB_URL" --repo lawbor \
  --description "LAWBOR — decentralized, reputation-gated agent messaging + a job graph whose outcomes are proven PAID by real USDC transfers on Base. Standing is conserved (a collusion ring earns zero); the node holds no key. MIT. Try: npx -y -p lawbor-bot lawbor-try bazaar"

echo
DID_KEY="$(echo "$MY_DID" | cut -d: -f3)"
echo "✅ LAWBOR mirrored to gitlawb (current master)"
echo "   profile: https://gitlawb.com/${DID_KEY:0:8}"
echo "   verify:  gl repo list   (should now show 'lawbor' next to 'toshi')"
