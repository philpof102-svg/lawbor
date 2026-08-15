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
#
# ⛔ "NO IDENTITY HERE" IS NOT "NO IDENTITY", AND THE DIFFERENCE IS THE ACCOUNT.
#    Measured 2026-08-15 against the real gl CLI: `gl identity show` reads $HOME/.gitlawb/identity.pem
#    and NOTHING else — an unreachable GITLAWB_NODE still exits 0, and a different $HOME exits 1 with
#    "no identity found". So sudo, another WSL distro, a container, or a fresh checkout on a second
#    machine all produce that exit 1 while the real key sits safely on disk somewhere else.
#    This branch used to answer that by MINTING A NEW DID and carrying on to the mirror. Both paths
#    then ended on the same "✅ LAWBOR mirrored to gitlawb" line, so the success message could not
#    tell "republished under our account" from "published under a brand-new one". That is not a
#    cosmetic difference: gitlawb standing is a PUSH COUNTER, so a fresh DID restarts it at zero
#    while the old profile keeps the history — and nothing on screen said which one just happened.
#    Creating an identity is therefore OPT-IN and never a fallback. Refusing costs a re-run; guessing
#    costs the account.
IDENTITY_ORIGIN="reused"
if gl identity show >/dev/null 2>&1; then
  echo "· identity exists (reused): $(gl identity show)"
else
  if [ "${GITLAWB_NEW_IDENTITY:-}" != "1" ]; then
    cat >&2 <<EOF

⛔ No gitlawb identity is readable from HOME=$HOME (expected $HOME/.gitlawb/identity.pem).

   This script will NOT mint one for you. Publishing under a new DID is not a smaller version of
   publishing — it is publishing as SOMEBODY ELSE: the standing counter restarts at zero and the
   existing profile (the one that already carries Toshi) keeps the history.

   Pick the one that is true:
     · the key exists but this shell cannot see it  -> run WITHOUT sudo / in the right WSL distro,
       or copy ~/.gitlawb/identity.pem into place, then re-run;
     · you really do want a brand-new account       -> GITLAWB_NEW_IDENTITY=1 bash "\$0"
EOF
    exit 3
  fi
  echo "· GITLAWB_NEW_IDENTITY=1 — minting a NEW DID ON PURPOSE (saved to ~/.gitlawb/identity.pem — BACK THIS FILE UP)"
  gl identity new
  IDENTITY_ORIGIN="NEW"
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
# The success line must SAY which of the two things happened. A message identical in both worlds is
# not a report, it is a shrug: the reader cannot tell a republish from a first push by a new account.
if [ "$IDENTITY_ORIGIN" = "NEW" ]; then
  echo "✅ LAWBOR mirrored to gitlawb (current master) — under a BRAND-NEW DID minted by this run"
  echo "   ⚠️ standing starts at ZERO for this identity; anything published earlier lives on the OLD profile"
else
  echo "✅ LAWBOR mirrored to gitlawb (current master) — under the EXISTING DID (reused, standing preserved)"
fi
echo "   profile: https://gitlawb.com/${DID_KEY:0:8}"
echo "   verify:  gl repo list   (should now show 'lawbor' next to 'toshi')"
