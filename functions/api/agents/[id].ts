import type { Env } from "../../../src/auth.ts";
import { agentDetail, deleteAgent, updateAgent } from "../../../src/api.ts";

export const onRequestGet: PagesFunction<Env> = ({ params, env }) => agentDetail(env, String(params.id));
export const onRequestPatch: PagesFunction<Env> = ({ params, env, request }) => updateAgent(env, String(params.id), request);
export const onRequestDelete: PagesFunction<Env> = ({ params, env }) => deleteAgent(env, String(params.id));
