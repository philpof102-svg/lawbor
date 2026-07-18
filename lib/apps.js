'use strict';
/**
 * LAWBOR — apps.js  (ship on it: apps register HTTP routes + MCP tools on a node)
 * ================================================================================
 * The extensibility layer. An "app" — a game, a content feed, a tool — is a plain module that
 * declares routes and/or tools; a node loads a list of them and exposes them alongside the built-in
 * surface. "Ship a game on LAWBOR" is: write one module, add it to the list. No fork, no core edit.
 *
 * An app is:
 *   {
 *     name: 'tictactoe',                 // kebab-case, unique; namespaces its routes/tools
 *     description: 'a game',
 *     premium?: true,                    // if true, its routes/tools require an active x402 subscription
 *     routes?: [ { method:'GET', path:'/play', handle(ctx) -> {status?, body} } ],
 *     tools?:  [ { name:'move', description, inputSchema, handle(args, ctx) -> payload } ],
 *   }
 * Route paths are exposed under /app/<name><path>; tool names under app_<name>_<tool>. ctx carries
 * { node, store, query, body, caller } so an app reads/writes through the node, never the raw socket.
 *
 * 🛑 Same rules as the rest of LAWBOR: an app handler runs in-process, holds no key, signs nothing,
 *   and moves no funds. A PREMIUM app is gated by the injected paywall (lib/paywall.js) — the node
 *   returns 402 and only runs the handler once payment to the operator's wallet is verified. Because
 *   the node is open-source, a paid app is only meaningful on a HOSTED node the operator runs; a fork
 *   removes the gate, which is why we sell hosted CONTENT/ACCESS, never the software (see PLATFORM.md).
 */

const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const PATH_RE = /^\/[a-z0-9/_-]*$/i;

/** Validate + index a list of apps. Throws on a malformed app (a broken app must not load silently). */
function createApps(apps = [], deps = {}) {
  const paywall = deps.paywall || null;                    // { active(caller) -> bool, challenge() -> {status,headers,body} }
  const list = [];
  const routeMap = new Map();                              // "METHOD /app/<name><path>" -> {app, route}
  const toolMap = new Map();                               // "app_<name>_<tool>" -> {app, tool}
  const toolDefs = [];

  for (const app of Array.isArray(apps) ? apps : []) {
    if (!app || !NAME_RE.test(app.name)) throw new Error('app name must be kebab-case [a-z0-9-]: ' + (app && app.name));
    if (list.some((a) => a.name === app.name)) throw new Error('duplicate app name: ' + app.name);
    const meta = { name: app.name, description: String(app.description || ''), premium: app.premium === true, routes: [], tools: [] };

    for (const r of Array.isArray(app.routes) ? app.routes : []) {
      const method = String(r.method || 'GET').toUpperCase();
      if (!PATH_RE.test(r.path || '')) throw new Error(app.name + ': bad route path ' + r.path);
      if (typeof r.handle !== 'function') throw new Error(app.name + ' route ' + r.path + ': handle must be a function');
      const full = '/app/' + app.name + r.path;
      const key = method + ' ' + full;
      if (routeMap.has(key)) throw new Error('duplicate route ' + key);
      routeMap.set(key, { app: meta, route: r });
      meta.routes.push({ method, path: full });
    }
    for (const t of Array.isArray(app.tools) ? app.tools : []) {
      if (!NAME_RE.test(t.name)) throw new Error(app.name + ': bad tool name ' + t.name);
      if (typeof t.handle !== 'function') throw new Error(app.name + ' tool ' + t.name + ': handle must be a function');
      const full = 'app_' + app.name + '_' + t.name;
      if (toolMap.has(full)) throw new Error('duplicate tool ' + full);
      toolMap.set(full, { app: meta, tool: t });
      const desc = (meta.premium ? '[PREMIUM · x402] ' : '') + String(t.description || '');
      meta.tools.push({ name: full, description: desc });
      toolDefs.push({ name: full, description: desc, inputSchema: t.inputSchema || { type: 'object', properties: {}, additionalProperties: true } });
    }
    list.push(meta);
  }

  // A premium surface is allowed through only if the caller holds an active subscription; otherwise
  // the node answers with the x402 challenge (402 + payment pointer). Fail-closed: a premium app with
  // no paywall wired is NEVER served (it must not fall open to free).
  function gate(isPremium, caller) {
    if (!isPremium) return { ok: true };
    if (!paywall) return { ok: false, resp: { status: 503, body: { error: 'premium app but no paywall configured — refused (fail closed)' } } };
    if (paywall.active(caller)) return { ok: true };
    return { ok: false, resp: paywall.challenge() };       // 402 with the x402 payment-required pointer
  }

  return {
    apps: () => list.map((a) => ({ name: a.name, description: a.description, premium: a.premium, routes: a.routes.map((r) => r.method + ' ' + r.path), tools: a.tools.map((t) => t.name) })),
    mcpTools: () => toolDefs,

    /** Dispatch an HTTP request to an app route. Returns null if no app owns it (so the core 404s). */
    async http(method, path, ctx = {}) {
      const hit = routeMap.get(String(method).toUpperCase() + ' ' + path);
      if (!hit) return null;
      const g = gate(hit.app.premium, ctx.caller);
      if (!g.ok) return g.resp;
      const out = await hit.route.handle(ctx);
      // A route may return {contentType, body:<string>} to serve a raw page (HTML/SVG/text) instead of
      // JSON — this is what lets an app ship a UI (a game screen, a dashboard), not just data.
      return { status: (out && out.status) || 200, body: out ? (out.body !== undefined ? out.body : out) : {}, contentType: out && out.contentType };
    },

    /** Dispatch an MCP tool call to an app tool. Returns null if no app owns it. */
    async tool(name, args = {}, ctx = {}) {
      const hit = toolMap.get(name);
      if (!hit) return null;
      const g = gate(hit.app.premium, ctx.caller);
      if (!g.ok) return { isError: true, text: g.resp.status === 402 ? 'payment required (x402): ' + JSON.stringify(g.resp.body) : (g.resp.body && g.resp.body.error) || 'refused' };
      const payload = await hit.tool.handle(args, ctx);
      return { isError: false, payload };
    },
  };
}

module.exports = { createApps };
