# Deploying TREK to Fly.io (scale-to-zero)

TREK is a good fit for Fly's `auto_stop_machines` because it's idle most of the time. When no traffic arrives, the machine sleeps; the next HTTP or WebSocket hit wakes it up in ~1–2 seconds. You pay for the mounted volumes (pennies per month) and only for CPU/RAM while the machine is running.

The checked-in [`fly.toml`](../fly.toml) is pre-wired for this. What follows is the full one-time setup.

## 0. Prerequisites

- A [Fly.io](https://fly.io) account with a payment method attached (remote builders are gated on trial-only accounts and will hang in "Waiting for builder…"). The free allowance comfortably covers an idle TREK.
- [`flyctl`](https://fly.io/docs/flyctl/install/) installed locally and `fly auth login` run.

## 1. Create the app

```bash
fly apps create <your-app-name>            # e.g. trek-abc123
```

Then open `fly.toml` and set `app = '<your-app-name>'` at the top. (If you used `fly launch`, it'll already be set.)

## 2. Create the persistent volume

TREK keeps its SQLite database at `/app/data` and user uploads at `/app/uploads`. Fly's shared-cpu machines support exactly one volume mount per machine, so the shipped config collapses both onto a single `trek_data` volume (uploads are symlinked onto `/app/data/uploads` at container startup). Size it to cover DB + uploads together:

```bash
fly volumes create trek_data -a <your-app-name> -r <region> -s 4
```

Pick the same `<region>` you listed as `primary_region` in `fly.toml` (e.g. `iad`, `ams`, `fra`). 4 GB is a reasonable starting size — bump it if you plan to attach a lot of photos/PDFs.

**Double-check that your `fly.toml` mounts it.** The shipped config includes:

```toml
[[mounts]]
  source = 'trek_data'
  destination = '/app/data'
```

If you ran `fly launch` on an older version of this repo and the `[[mounts]]` section is missing, add it now — without it every image-level deploy creates fresh machines with ephemeral storage, silently wiping your database.

**Stay at one machine.** TREK stores everything in SQLite, which can't be shared across hosts — two machines would give you two independent databases that silently diverge. Fly often auto-provisions two machines on `fly launch`; if yours has two (check `fly status`), destroy one and run `fly scale count 1`. Since you only created one `trek_data` volume above, Fly will also refuse to boot a second machine anyway — a helpful accidental safety net.

## 3. Set secrets **before** the first deploy

This order matters. TREK auto-seeds an admin account on first boot. If `ADMIN_EMAIL` / `ADMIN_PASSWORD` are set, the seed uses those. If they aren't, it generates a random password and prints it to stdout — which is fine on a laptop but can roll out of Fly's log buffer on a real deploy, leaving you locked out.

```bash
fly secrets set \
  ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  ADMIN_EMAIL="you@example.com" \
  ADMIN_PASSWORD="$(openssl rand -base64 24)" \
  -a <your-app-name>
```

Write the password down — you'll need it for the first login. TREK will force a password change on that login, so this one only has to be strong enough to survive a few minutes.

Optional extras you can set here too:
- `TZ=Europe/Berlin` for server-side timezone
- `SMTP_HOST`, `SMTP_PORT`, etc. if you want email notifications
- `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` for SSO

## 4. Deploy

```bash
fly deploy -a <your-app-name>
```

The first build takes ~3–5 minutes (multi-stage Node build). Subsequent deploys are faster thanks to layer caching.

## 5. Verify

```bash
curl -I https://<your-app-name>.fly.dev/api/health   # expect HTTP/2 200
```

Then open the app in a browser, log in with the credentials from step 3, and change the password when prompted.

## 6. Turn on MCP

See [`claude-setup.md`](claude-setup.md) for wiring Claude Code / Desktop / .ai once TREK is live.

---

## Operational notes

### Scale-to-zero behavior

The shipped `fly.toml` uses `auto_stop_machines = 'stop'` + `min_machines_running = 0`. Expect:
- After ~60s of no traffic the machine stops (volume stays attached).
- First request after sleep: ~1–2s cold start, then normal response times.
- WebSocket clients (the web UI's real-time sync) reconnect automatically on wake. MCP sessions are short-lived HTTP, so there's no disconnect issue there.

### Resetting the admin (if seed already ran without secrets)

If step 3 was skipped and the random admin password is lost, set the three
secrets below and restart — no SSH required. On the next boot, the seed
checks `FORCE_RESEED_ADMIN`; when it's `true` **and** `ADMIN_EMAIL` /
`ADMIN_PASSWORD` are both set, it deletes existing users and seeds a fresh
admin with your chosen credentials:

```bash
fly secrets set \
  ADMIN_EMAIL="you@example.com" \
  ADMIN_PASSWORD="$(openssl rand -base64 24)" \
  FORCE_RESEED_ADMIN=true \
  -a <your-app-name>
```

Fly restarts the machines automatically when secrets change. **After you log
in, remove the flag** so a future restart doesn't wipe your data:

```bash
fly secrets unset FORCE_RESEED_ADMIN -a <your-app-name>
```

### Backups

TREK's in-app backup addon writes archives to `/app/data/backups/` — i.e. onto the `trek_data` volume. For off-box backups, use Fly's volume snapshots (automatic, 5-day retention by default) or set up an external S3 target in the admin panel.

### Upgrading

Push to `main`. If you installed the Fly GitHub App, it deploys automatically. Otherwise:

```bash
fly deploy -a <your-app-name>
```
