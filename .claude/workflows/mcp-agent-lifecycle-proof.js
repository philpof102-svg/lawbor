export const meta = {
  name: 'mcp-agent-lifecycle-proof',
  description: 'Prove honestly what an autonomous agent can do on LAWBOR: read, create, negotiate, prove keys, pay — via MCP + signed envelopes',
  phases: [
    { title: 'Probe', detail: '4 independent capability probes against the LIVE node' },
    { title: 'Verdict', detail: 'adversarial synthesis: what is overclaimed, what breaks first' },
  ],
}

const NODE = 'https://lawbor-node-production.up.railway.app'
const REPO = 'D:/Users/VolKov/veilleIA/lawbor'
const SAFETY = `SAFETY (absolute): NEVER touch or kill any server on port 4700 (a human is testing against it). NEVER use a funded or real key — generate throwaway keys only, store them under the OS temp dir. NEVER call any tool that sends/swaps/signs funds. Anything you create on the live node MUST have "SELFTEST-" in its name/item. Do not npm publish. Do not git commit or push.`

const PROBE = { type: 'object', required: ['capability', 'verdict', 'evidence', 'gaps'], properties: {
  capability: { type: 'string' },
  verdict: { type: 'string', description: 'WORKS / PARTIAL / BLOCKED + one-line summary' },
  evidence: { type: 'array', items: { type: 'string' }, description: 'exact commands run + exact responses (trimmed), enough for someone else to re-verify' },
  gaps: { type: 'array', items: { type: 'string' }, description: 'honest limits found — what an agent CANNOT do on this path' },
} }

const probes = [
  { key: 'read', prompt: `${SAFETY}
You are auditing what an ANONYMOUS agent (no key, no config) can READ from the live LAWBOR node ${NODE}.
Using curl (with --max-time 20) or node fetch, probe: (1) GET ${NODE}/.well-known/mcp.json — the discovery card; list which MCP tools it declares. (2) POST ${NODE}/mcp with JSON-RPC {"jsonrpc":"2.0","id":1,"method":"tools/list"} — list the tools actually served. (3) tools/call each READ tool you find (lawbor_bazaar, lawbor_jobs, lawbor_wanted, lawbor_peer with of=0xac3ca7c5d3cdd7702fd08f9c4c28daa22296ada9, lawbor_credit if present) and record what real data comes back. (4) GET ${NODE}/health, /bazaar, /jobs, /wanted, /credit. Report exactly which reads work anonymously and what data an agent actually gets.` },
  { key: 'create', prompt: `${SAFETY}
You are auditing whether a STRANGER agent can CREATE (write) on the live LAWBOR node ${NODE}. Two doors exist — prove the posture of each:
(A) Hosted MCP write door: POST ${NODE}/mcp tools/call with name lawbor_offer (args: jobId "SELFTEST-probe-write", item "SELFTEST"), and also lawbor_say. EXPECTED: refused (operator-gated, fail-closed). Record the exact refusal (status + body).
(B) Signed-envelope door: from the local repo ${REPO}, run: LAWBOR_TRY_KEY_FILE="$TMPDIR/probe-create-key" node bin/lawbor-try.js offer "SELFTEST-agent-create-probe" 1000000  (Git Bash; use a temp path that exists, e.g. $HOME/.lawbor-selftest-key is fine too). This generates a throwaway key and signs a real envelope. EXPECTED: accepted (authenticated create). Then run the quote and confirm subcommands (amounts 1000000) with a SECOND throwaway key file for the buyer quote, and verify agreedPrice.accepted=true via GET ${NODE}/jobs (find your jobId).
Report both doors' exact behavior: the write path that is CLOSED to strangers and the one that is OPEN-with-signature.` },
  { key: 'stdio-and-keyproof', prompt: `${SAFETY}
You are auditing the AGENT-SIDE tooling in ${REPO}: the stdio MCP and the free key-proof path.
(A) stdio MCP: read bin/lawbor-mcp.js header comments to understand its posture, then spawn it (node bin/lawbor-mcp.js) and speak MCP over stdin: send {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}} then notifications/initialized then tools/list. Record the tool names. Then tools/call lawbor_offer with test args and record what comes back — EXPECTED per design: a DESCRIPTOR to sign (the MCP holds no key and signs nothing), not a completed write. Confirm from the output that it is descriptor-only. Kill the child process when done (it is YOUR child, not the port-4700 server).
(B) Free key-proof (validate by keySig): read lib/work.js around 'keySig' to get the exact message format (LAWBOR-KEY:<addr>). With node + viem (available in the repo's node_modules), generate a throwaway key, sign the message "LAWBOR-KEY:<its-address>" (EIP-191 personal sign), and send a validate envelope citing keyAddr+keySig on a job you create first (offer "SELFTEST-keyproof" via the same envelope path lawbor-try uses — you may reuse bin/lawbor-try.js code by requiring lib/envelope + lib/work directly in a small script). Then GET ${NODE}/jobs and check your job's validations: does it show verified:true with via:'signature'? That is the ZERO-FUNDS way an agent proves it controls its address. Report exactly what worked.` },
  { key: 'bazaar-hygiene', prompt: `${SAFETY}
You are auditing what a FIRST-TIME VISITOR (from X) sees on the live LAWBOR bazaar, and whether listings can be cleaned up.
(1) GET ${NODE}/bazaar and ${NODE}/jobs — list EVERY offer/job currently visible: jobId, item, state. How many are obvious test junk (SELFTEST-, demo-, try- prefixes)? What does the board look like to a stranger?
(2) Read ${REPO}/lib/work.js — the fold. Answer precisely: can an OFFER (state 'offered') ever be cancelled/delisted? Look at the cancel handler (it requires state==='open') and mayApply. If offers are permanent, that is a real finding: test junk pollutes the public board forever.
(3) Check whether /bazaar filters anything (read the /bazaar handler in ${REPO}/server.js) — does it show all offers or only some subset? Why was the bazaar EMPTY earlier today if offers were created (were they created only after the check, or is there a filter)?
Report: exact current board contents, whether delisting exists, and the cleanest fix if it does not (e.g. a delist verb for the owner, honest and fold-derived).` },
]

phase('Probe')
const results = await parallel(probes.map((p) => () => agent(p.prompt, { label: 'probe:' + p.key, phase: 'Probe', schema: PROBE })))

phase('Verdict')
const verdict = await agent(`You are an adversarial reviewer for an anti-hype team (rule: only verified claims, never inflate). Here are 4 capability-probe results for "can autonomous agents create / read / negotiate / prove keys / pay on LAWBOR via MCP + signed envelopes":
${JSON.stringify(results, null, 2)}
Produce: (1) an honest capability matrix (capability -> WORKS/PARTIAL/BLOCKED -> one-line proof), (2) the single biggest gap for a stranger agent arriving from X, (3) any claim in the probes that looks overclaimed or unverified — flag it. Be terse and concrete. PAY note: settling requires the agent's own wallet to move real USDC on Base — LAWBOR only verifies the tx; nobody in this audit moves funds, so mark PAY as verified-by-design+tests if the probes show the settle verification path, never as "proven live" unless a real settled tx exists on the node.`, { label: 'verdict', phase: 'Verdict', effort: 'high' })

return { results, verdict }