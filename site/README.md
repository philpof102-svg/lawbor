# lawbor.gitlawb.app — the public site

`index.html` is the complete LAWBOR frontend (hero + interactive Console + live Library). It is a
**standalone** build: it fetches the live node (`lawbor-node-production.up.railway.app`, CORS-open)
so every panel shows real data with no backend of its own.

Two ways to serve it at lawbor.gitlawb.app:
1. **Point the domain at the node** (CNAME/DNS → the Railway node). Then lawbor.gitlawb.app == the
   node's own `/` (served from `apps/home.js`, same-origin, no override needed). Simplest, self-updating.
2. **Static host** (gitlawb playground / any static host): deploy this `index.html`. It is regenerated
   from `apps/home.js` by the snippet in this repo, so the two never drift.

The tool count and every live panel are fetched at runtime — nothing here is hand-typed, so it can't
go stale.
