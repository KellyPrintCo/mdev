import type { Env } from "../../src/auth.ts";
import { ingest } from "../../src/ingest.ts";

// Auth (bearer token) is enforced in _middleware.ts.
export const onRequestPost: PagesFunction<Env> = ({ request, env }) => ingest(request, env);
