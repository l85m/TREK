# Connecting Claude to TREK

TREK ships a built-in [MCP](https://modelcontextprotocol.io/) server so Claude can plan trips *with* you and write the result straight into TREK. This page covers setup for the three common Claude clients. The full tool reference lives in [`MCP.md`](../MCP.md).

## Prerequisites

1. An administrator has enabled the **MCP** addon under **Admin Panel → Addons**.
2. You've created a token at **Settings → MCP Configuration → Create New Token** and copied it (you only see it once).
3. Your TREK instance is reachable at an HTTPS URL, e.g. `https://trek.example.com`. The MCP endpoint is `<your-url>/mcp`.

> Tip: the same `trek_…` token works for both the MCP endpoint and the REST API (and the [`trek` CLI](../cli/)).

---

## Claude Code (this CLI)

### Option A: Project-level `.mcp.json` (recommended)

Copy the template, fill in your URL and token, then launch Claude Code from the repo root:

```bash
cp .mcp.json.example .mcp.json
$EDITOR .mcp.json       # set url + Bearer token
```

`.mcp.json` is gitignored so your token never lands in git.

### Option B: User-level install

```bash
claude mcp add --transport http trek https://trek.example.com/mcp \
  --header "Authorization: Bearer trek_your_token_here"
```

Verify with `claude mcp list` — you should see `trek` listed. Then in a session, try: *"list my trips"*.

---

## Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config) and add the `trek` server. Claude Desktop uses stdio servers, so we bridge over HTTP with `mcp-remote`:

```json
{
  "mcpServers": {
    "trek": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://trek.example.com/mcp",
        "--header",
        "Authorization: Bearer trek_your_token_here"
      ]
    }
  }
}
```

Restart Claude Desktop. On Windows you may need the full `npx` path (e.g. `C:\PROGRA~1\nodejs\npx.cmd`).

---

## Claude.ai (web, Custom Connectors)

1. Go to claude.ai → **Settings → Connectors → Add custom connector**.
2. Name: `TREK`.
3. Remote MCP server URL: `https://trek.example.com/mcp`.
4. Auth: *Bearer token*, value `trek_your_token_here`.
5. Save, then enable the connector in a new chat.

---

## Quick smoke test

Once connected, ask Claude:

> *"Use TREK to list my trips, then give me a recap of the most recent one."*

Claude should call `list_trips`, pick the latest, and call `get_trip_summary` on it.

## Troubleshooting

- **`403 MCP is not enabled`** — admin hasn't turned on the MCP addon.
- **`401 Access token required`** — header missing or token revoked. Regenerate.
- **`429 Too many requests`** — 60 req/min per user is the default; set `MCP_RATE_LIMIT` higher if needed.
- **`429 Session limit reached`** — 5 concurrent sessions/user; close old clients or raise `MCP_MAX_SESSION_PER_USER`.
- **Tools missing** — bump your MCP client; older versions cache tool lists.

See [`MCP.md`](../MCP.md) for the full list of tools and resources.
