import type { Env } from "../../../src/auth.ts";
import { listAgents } from "../../../src/api.ts";

export const onRequestGet: PagesFunction<Env> = ({ request, env }) => listAgents(env, new URL(request.url));
