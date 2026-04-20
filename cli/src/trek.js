#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

// ─────────────────────────────────────────────────────────────────────────────
// Config

const CONFIG_DIR = path.join(os.homedir(), '.trek');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

function loadConfig() {
  const fromEnv = {
    url: process.env.TREK_URL,
    token: process.env.TREK_TOKEN,
  };
  let fromFile = {};
  try {
    fromFile = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch { /* ignore */ }
  return {
    url: fromEnv.url || fromFile.url,
    token: fromEnv.token || fromFile.token,
  };
}

function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

// ─────────────────────────────────────────────────────────────────────────────
// Argv parsing — positional args + --flags, no third-party deps.

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP

async function request(method, pathPart, { body, query } = {}) {
  const cfg = loadConfig();
  if (!cfg.url || !cfg.token) {
    fail('No URL/token configured. Run: trek login --url <https://…> --token trek_… (or set TREK_URL and TREK_TOKEN).');
  }
  const base = cfg.url.replace(/\/+$/, '');
  const p = pathPart.startsWith('/') ? pathPart : `/${pathPart}`;
  const qs = query && Object.keys(query).length
    ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null)).toString()
    : '';
  const url = `${base}${p}${qs}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = typeof data === 'object' && data?.error ? data.error : `HTTP ${res.status}`;
    fail(`${method} ${url} → ${msg}`);
  }
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Output helpers

function out(data) {
  if (typeof data === 'string') console.log(data);
  else console.log(JSON.stringify(data, null, 2));
}

function fail(msg) {
  console.error(`trek: ${msg}`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands

const commands = {
  async login(pos, flags) {
    const url = flags.url;
    const token = flags.token;
    if (!url || !token) fail('Usage: trek login --url <https://your-trek> --token trek_…');
    saveConfig({ url: url.replace(/\/+$/, ''), token });
    out(`Saved config to ${CONFIG_PATH}`);
  },

  async whoami() {
    const me = await request('GET', '/api/auth/me');
    out(me);
  },

  async trips(pos, flags) {
    const data = await request('GET', '/api/trips', {
      query: { include_archived: flags['include-archived'] ? 1 : undefined },
    });
    out(data);
  },

  async trip(pos) {
    const id = pos[0];
    if (!id) fail('Usage: trek trip <tripId>');
    const data = await request('GET', `/api/trips/${id}`);
    out(data);
  },

  async summary(pos) {
    const id = pos[0];
    if (!id) fail('Usage: trek summary <tripId>');
    // Equivalent of the MCP get_trip_summary: compose from public REST routes.
    const [trip, days, places, budget, packing, reservations, todos] = await Promise.all([
      request('GET', `/api/trips/${id}`),
      request('GET', `/api/trips/${id}/days`).catch(() => null),
      request('GET', `/api/trips/${id}/places`).catch(() => null),
      request('GET', `/api/trips/${id}/budget`).catch(() => null),
      request('GET', `/api/trips/${id}/packing`).catch(() => null),
      request('GET', `/api/trips/${id}/reservations`).catch(() => null),
      request('GET', `/api/trips/${id}/todos`).catch(() => null),
    ]);
    out({ trip, days, places, budget, packing, reservations, todos });
  },

  async todos(pos) {
    const id = pos[0];
    if (!id) fail('Usage: trek todos <tripId>');
    const data = await request('GET', `/api/trips/${id}/todos`);
    out(data);
  },

  async notifications(pos, flags) {
    const query = {};
    if (flags.unread) query.unreadOnly = '1';
    if (flags.limit) query.limit = flags.limit;
    const data = await request('GET', '/api/notifications/in-app', { query });
    out(data);
  },

  async weather(pos, flags) {
    const lat = flags.lat;
    const lng = flags.lng;
    if (lat === undefined || lng === undefined) fail('Usage: trek weather --lat <n> --lng <n> [--date YYYY-MM-DD]');
    const query = { lat, lng };
    if (flags.date) query.date = flags.date;
    const data = await request('GET', '/api/weather', { query });
    out(data);
  },

  async raw(pos, flags) {
    const method = (pos[0] || 'GET').toUpperCase();
    const p = pos[1];
    if (!p) fail('Usage: trek raw <METHOD> <path> [--json \'{"…": …}\']');
    const body = flags.json ? JSON.parse(flags.json) : undefined;
    const data = await request(method, p, { body });
    out(data);
  },

  async help() {
    console.log(`trek — tiny CLI for the TREK REST API

Usage:
  trek login --url <url> --token <trek_...>   Save credentials to ~/.trek/config.json
  trek whoami                                  Show the authenticated user
  trek trips [--include-archived]              List all trips
  trek trip <id>                               Show a single trip
  trek summary <id>                            Pull a denormalized trip snapshot
  trek todos <tripId>                          List todos on a trip
  trek notifications [--unread] [--limit N]    List in-app notifications
  trek weather --lat <n> --lng <n> [--date YYYY-MM-DD]   Weather for coords
  trek raw <METHOD> <path> [--json '…']        Escape hatch to any REST endpoint

Config:
  TREK_URL and TREK_TOKEN env vars take precedence over ~/.trek/config.json.
  Create a token at: <your-trek>/settings  →  MCP Configuration  →  Create New Token.
  (The same trek_* token works for the REST API and the MCP endpoint.)
`);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Main

const [, , cmd, ...rest] = process.argv;
if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  commands.help();
  process.exit(0);
}

const handler = commands[cmd];
if (!handler) fail(`Unknown command: ${cmd}. Try: trek help`);

const { positional, flags } = parseArgs(rest);
handler(positional, flags).catch((err) => fail(err?.message || String(err)));
