# Claude Agent Status

A Cloudflare Pages dashboard that shows the live status of every Claude Code agent you run, on your own machines or in claude.ai/code cloud sessions. Only **max.kelly@students.rsd.edu** can view it.

- **Live status** for each session: *working*, *needs you* (waiting on permission), *idle*, *quiet / stalled?*, *long-running tool*, *offline* and *ended*. Updates every 4 seconds.
- **Time-left estimates** with a range and a confidence level:
  - When the agent has a plan (TodoWrite / Task tools), the estimate comes from how fast it is getting through the plan items.
  - Otherwise, it compares the current turn with your past turn durations (same project first, then all projects). It also flags turns that are running longer than usual.
- **"All done in ~X"** across every running agent, plus a projected finish clock time.
- **Current activity** ("Editing provider.ts", "Profile the ETL job"…), the plan checklist, a 30-minute activity sparkline, and counts of turns, tool calls, errors, subagents and tokens.
- **Details drawer**: full plan, last prompt and reply, a chart of turn durations, a tool-usage breakdown, an event timeline, and a link back to the claude.ai session for cloud agents.
- **Browser notifications** when an agent needs you, finishes, or goes quiet. The tab title and favicon also change colour.
- Filters, search, time range, light/dark themes, and a mobile layout.

## How it works

```
Claude Code hooks ──POST /api/ingest (bearer token)──▶ Pages Functions ──▶ D1
                                                            ▲
Browser (Cloudflare Access login, email locked) ──GET /api/agents──┘
```

`hooks/agent-status.sh` runs on Claude Code hook events (SessionStart, UserPromptSubmit, Pre/PostToolUse, Notification, Stop, SubagentStop, PreCompact, SessionEnd). It forwards the event in the background, so it never slows down or breaks an agent.

## Access control (two locks)

1. **Cloudflare Access** in front of the site, with a policy that allows only `max.kelly@students.rsd.edu`.
2. **`functions/_middleware.ts`** checks the Access JWT on every request: signature against your team's keys, issuer, audience, expiry, and `email == ALLOWED_EMAIL`. It fails closed: if Access isn't configured, the site returns an error instead of the dashboard. This also protects `*.pages.dev` preview URLs.

Only `/api/ingest` skips Access. It requires the `INGEST_TOKEN` bearer secret and can only write events, never read them.

## Deploy

You need a Cloudflare account and Node 18+.

```bash
npm install
npx wrangler login

# 1. Database
npx wrangler d1 create agent-status          # copy the database_id into wrangler.toml
npm run db:migrate:remote

# 2. Pages project + ingest secret
npx wrangler pages project create claude-agent-status --production-branch main
openssl rand -hex 32                          # save this: it's your INGEST_TOKEN
npx wrangler pages secret put INGEST_TOKEN --project-name claude-agent-status
npm run deploy
```

### Lock it down with Cloudflare Access

In the Cloudflare dashboard, open **Zero Trust**. The free plan covers up to 50 users.

1. **Settings → Authentication**: make sure **One-time PIN** is enabled. It lets the school email sign in with a code sent to the inbox. You can add Google as well if the school uses Google accounts.
2. **Access → Applications → Add → Self-hosted**:
   - Domain: `claude-agent-status.pages.dev`. Add a second entry for `*.claude-agent-status.pages.dev` (previews), plus any custom domain.
   - Policy: **Allow**, Include → **Emails** → `max.kelly@students.rsd.edu`.
   - After saving, copy the **Application Audience (AUD) Tag**.
3. Add a **second** application for the same domain with path **`api/ingest`** and a policy of action **Bypass**, Include → **Everyone**. This lets agents report in; the bearer token still protects the path.
4. Put your team domain (e.g. `yourteam.cloudflareaccess.com`, shown under Settings → Custom pages) and the AUD tag into `wrangler.toml` under `[vars]`. Then run `npm run deploy` again.

Open the site. You should be asked to sign in, and any other email gets "Access denied".

## Connect your agents

**Your own computers** (macOS/Linux/WSL, needs `jq` and `curl`):

```bash
./hooks/install.sh https://claude-agent-status.pages.dev <INGEST_TOKEN>
```

This copies the hook to `~/.claude/hooks/`, saves the URL and token to `~/.claude/agent-status.env` (mode 600), and adds the hooks to `~/.claude/settings.json`. It backs up the old settings first. New sessions show up within seconds.

**Cloud sessions (claude.ai/code)**: cloud containers don't have your `~/.claude`, so add the hook to each repo instead:

1. Copy `hooks/agent-status.sh` into the repo as `.claude/hooks/agent-status.sh`.
2. Merge `hooks/project-settings.example.json` into the repo's `.claude/settings.json`.
3. In the cloud environment settings, add the environment variables `AGENT_STATUS_URL` and `AGENT_STATUS_TOKEN`. Make sure the network policy allows your Pages domain.

Cloud sessions get a ☁ badge and an "Open session ↗" link.

## Local development

```bash
cp .dev.vars.example .dev.vars   # bypasses Access on localhost only
npm run db:migrate:local
npm run dev                      # http://localhost:8788
AGENT_STATUS_URL=http://localhost:8788 AGENT_STATUS_TOKEN=dev-token \
  sh -c 'echo "{\"session_id\":\"t1\",\"hook_event_name\":\"UserPromptSubmit\",\"prompt\":\"hello\",\"cwd\":\"$PWD\"}" | hooks/agent-status.sh'
npm test && npm run typecheck
```

## Notes and limits

- Status comes from hook events. If a terminal is closed without a SessionEnd event, the session shows as **offline** after 3 hours idle. A working session with no events for 5 minutes shows as **stalled?**, or as **long-running tool** when a tool is still running.
- Estimates are estimates. They get better as the dashboard collects turn history (kept for 30 days), and agents that write a plan get much tighter ones.
- Only short summaries are stored (file names, command descriptions, the prompt, the last message). Raw tool output is never stored. Events are pruned after 7 days.
