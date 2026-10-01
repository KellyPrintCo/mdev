import type { Env } from "../../src/auth.ts";

export const onRequestGet: PagesFunction<Env> = ({ data }) => Response.json({ email: data.email });
