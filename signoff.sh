#!/usr/bin/env bash
# LAWBOR — the deterministic "done" gate.
# ========================================
# The fleet-contract principle (widely circulated mid-2026): "done" is NOT a model's claim that it
# finished — it is THIS script exiting 0. An agent that grades its own homework gives itself a raise;
# nothing here trusts a self-report. `npm run signoff` runs the whole bar and fails loudly on anything.
#   unit suite (all invariants) · interaction sim · dynamic-org sim · a fuzz smoke over random histories.
# Use it as the finish line before claiming a change is done, and as the CI gate.
set -euo pipefail
cd "$(dirname "$0")"

echo "== 1/4 unit suite =="
npm test

echo "== 2/4 interaction sim (5 real nodes) =="
node sim/interaction.js

echo "== 3/4 dynamic-org sim (self-rewriting graph) =="
node sim/dynamic-org.js

echo ""
echo "── rating under attack: a real collusion ring, moving real money ──────────────────────"
node sim/rating.js

echo "== 4/4 fuzz smoke (120 random histories, all invariants) =="
node sim/fuzz.js --scenarios 120 --actions 30

echo ""
echo "✅ SIGNOFF 0 — full bar green (unit + sims + fuzz). This, not a claim, is what 'done' means."
