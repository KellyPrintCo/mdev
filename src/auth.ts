// Verifies the Cloudflare Access JWT on every dashboard request and checks the
// email claim against ALLOWED_EMAIL. Cloudflare Access is the front door; this
// is the second lock, so a misconfigured Access policy or an unprotected preview
// URL still can't leak the dashboard.

export interface Env {
  DB: D1Database;
  ALLOWED_EMAIL: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  INGEST_TOKEN: string;
  DEV_BYPASS_AUTH?: string;
}

interface Jwk extends JsonWebKey {
  kid: string;
}

let jwksCache: { domain: string; keys: Jwk[]; fetchedAt: number } | null = null;

async function getKeys(domain: string, forceRefresh = false): Promise<Jwk[]> {
  const fresh = jwksCache && jwksCache.domain === domain && Date.now() - jwksCache.fetchedAt < 10 * 60_000;
  if (fresh && !forceRefresh) return jwksCache!.keys;
  const res = await fetch(`https://${domain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };
  jwksCache = { domain, keys: body.keys, fetchedAt: Date.now() };
  return body.keys;
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson(part: string): any {
  return JSON.parse(new TextDecoder().decode(b64urlDecode(part)));
}

export type AuthResult = { ok: true; email: string } | { ok: false; status: number; reason: string };

export async function verifyAccess(request: Request, env: Env): Promise<AuthResult> {
  const url = new URL(request.url);
  if (env.DEV_BYPASS_AUTH === "1" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
    return { ok: true, email: env.ALLOWED_EMAIL };
  }
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.ALLOWED_EMAIL) {
    return { ok: false, status: 500, reason: "Access is not configured (ACCESS_TEAM_DOMAIN / ACCESS_AUD / ALLOWED_EMAIL)." };
  }

  const token =
    request.headers.get("Cf-Access-Jwt-Assertion") ??
    request.headers.get("Cookie")?.match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1];
  if (!token) return { ok: false, status: 401, reason: "Not signed in through Cloudflare Access." };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, status: 401, reason: "Malformed token." };

  let header: any, payload: any;
  try {
    header = decodeJson(parts[0]);
    payload = decodeJson(parts[1]);
  } catch {
    return { ok: false, status: 401, reason: "Malformed token." };
  }
  if (header.alg !== "RS256") return { ok: false, status: 401, reason: "Unexpected token algorithm." };

  let keys = await getKeys(env.ACCESS_TEAM_DOMAIN);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await getKeys(env.ACCESS_TEAM_DOMAIN, true); // key rotation
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) return { ok: false, status: 401, reason: "Unknown signing key." };

  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlDecode(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) return { ok: false, status: 401, reason: "Bad token signature." };

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now) return { ok: false, status: 401, reason: "Session expired." };
  if (typeof payload.nbf === "number" && payload.nbf > now + 60) return { ok: false, status: 401, reason: "Token not yet valid." };
  if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return { ok: false, status: 401, reason: "Wrong issuer." };
  const aud: string[] = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return { ok: false, status: 401, reason: "Wrong audience." };

  const email = String(payload.email ?? "").toLowerCase();
  if (email !== env.ALLOWED_EMAIL.toLowerCase()) {
    return { ok: false, status: 403, reason: `${email || "This account"} is not allowed to view this dashboard.` };
  }
  return { ok: true, email };
}

/** Constant-time comparison for the ingest bearer token. */
export function tokenMatches(given: string | null, expected: string | undefined): boolean {
  if (!given || !expected) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
