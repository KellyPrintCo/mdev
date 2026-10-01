import { tokenMatches, verifyAccess, type Env } from "../src/auth.ts";

const SECURITY_HEADERS: Record<string, string> = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};

function withHeaders(res: Response, csp = true): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (csp || k !== "Content-Security-Policy") out.headers.set(k, v);
  return out;
}

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const { request, env } = ctx;
  const url = new URL(request.url);

  // Agents report in with a bearer token; they can't do an Access login.
  if (url.pathname === "/api/ingest") {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const auth = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? null;
    if (!tokenMatches(auth, env.INGEST_TOKEN)) return new Response("Unauthorized", { status: 401 });
    return ctx.next();
  }

  // Everything else (the page itself, its assets and the read API) needs the allowed Access identity.
  const result = await verifyAccess(request, env);
  if (!result.ok) {
    const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Access denied</title>
<body style="font-family:system-ui;background:#0b0d12;color:#e7e9ee;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px">
<div style="max-width:420px;text-align:center"><h1 style="font-size:20px">Access denied</h1><p style="color:#9aa3b2">${result.reason.replace(/[<>&]/g, "")}</p>
<p><a style="color:#8ab4ff" href="/cdn-cgi/access/logout">Sign out and try another account</a></p></div></body>`;
    return withHeaders(new Response(page, { status: result.status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }), false);
  }

  // Block cross-site writes.
  if (!["GET", "HEAD"].includes(request.method)) {
    const origin = request.headers.get("Origin");
    if (origin && new URL(origin).host !== url.host) return new Response("Bad origin", { status: 403 });
    if (request.headers.get("X-Requested-With") !== "dashboard") return new Response("Missing header", { status: 403 });
  }

  ctx.data.email = result.email;
  const res = await ctx.next();
  return withHeaders(res);
};
