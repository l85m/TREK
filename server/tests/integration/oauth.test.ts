/**
 * OAuth 2.1 authorization server integration tests.
 *
 * Exercises the full flow used by remote MCP clients (Claude.ai custom
 * connectors, etc.): dynamic client registration, authorization-code +
 * PKCE, token exchange, and scope-limited MCP access.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import type { Application } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const { testDb, dbMock } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  const mock = { db, closeDb: () => {}, reinitialize: () => {} };
  return { testDb: db, dbMock: mock };
});

vi.mock('../../src/db/database', () => dbMock);
vi.mock('../../src/config', () => ({
  JWT_SECRET: 'test-jwt-secret-for-trek-testing-only',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  updateJwtSecret: () => {},
}));

import { createApp } from '../../src/app';
import { createTables } from '../../src/db/schema';
import { runMigrations } from '../../src/db/migrations';
import { resetTestDb } from '../helpers/test-db';
import { createUser } from '../helpers/factories';
import { authCookie } from '../helpers/auth';
import { mintAccessToken, verifyMcpScopedJwt } from '../../src/services/oauthService';

const TEST_JWT_SECRET = 'test-jwt-secret-for-trek-testing-only';

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makePkce() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

const app: Application = createApp();

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
  // Enable MCP addon so /mcp handler isn't 403'd.
  testDb.prepare("UPDATE addons SET enabled = 1 WHERE id = 'mcp'").run();
});

beforeEach(() => {
  resetTestDb(testDb);
  testDb.prepare("UPDATE addons SET enabled = 1 WHERE id = 'mcp'").run();
});

afterAll(() => {
  testDb.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// Discovery metadata
// ─────────────────────────────────────────────────────────────────────────────

describe('Discovery metadata', () => {
  it('serves /.well-known/oauth-protected-resource', async () => {
    const res = await request(app).get('/.well-known/oauth-protected-resource');
    expect(res.status).toBe(200);
    expect(res.body.resource).toMatch(/\/mcp$/);
    expect(res.body.authorization_servers).toBeInstanceOf(Array);
    expect(res.body.scopes_supported).toContain('mcp');
  });

  it('serves /.well-known/oauth-authorization-server with required endpoints', async () => {
    const res = await request(app).get('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    expect(res.body.authorization_endpoint).toMatch(/\/oauth\/authorize$/);
    expect(res.body.token_endpoint).toMatch(/\/oauth\/token$/);
    expect(res.body.registration_endpoint).toMatch(/\/oauth\/register$/);
    expect(res.body.code_challenge_methods_supported).toContain('S256');
    expect(res.body.grant_types_supported).toContain('authorization_code');
    expect(res.body.grant_types_supported).toContain('refresh_token');
  });

  it('unauthenticated /mcp returns 401 with WWW-Authenticate pointing at resource metadata', async () => {
    const res = await request(app).post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('Bearer');
    expect(res.headers['www-authenticate']).toContain('/.well-known/oauth-protected-resource');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic client registration
// ─────────────────────────────────────────────────────────────────────────────

describe('Dynamic client registration', () => {
  it('registers a public client and returns no client_secret', async () => {
    const res = await request(app).post('/oauth/register').send({
      client_name: 'Test Client',
      redirect_uris: ['https://example.test/cb'],
    });
    expect(res.status).toBe(201);
    expect(res.body.client_id).toMatch(/^trek-oauth-/);
    expect(res.body.client_secret).toBeUndefined();
    expect(res.body.token_endpoint_auth_method).toBe('none');
  });

  it('registers a confidential client and returns a client_secret', async () => {
    const res = await request(app).post('/oauth/register').send({
      client_name: 'Confidential Client',
      redirect_uris: ['https://example.test/cb'],
      token_endpoint_auth_method: 'client_secret_post',
    });
    expect(res.status).toBe(201);
    expect(res.body.client_secret).toMatch(/.{20,}/);
  });

  it('rejects registration without redirect_uris', async () => {
    const res = await request(app).post('/oauth/register').send({ client_name: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client_metadata');
  });

  it('rejects non-http(s) redirect_uris', async () => {
    const res = await request(app).post('/oauth/register').send({
      client_name: 'x',
      redirect_uris: ['javascript:alert(1)'],
    });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Authorization endpoint
// ─────────────────────────────────────────────────────────────────────────────

async function registerTestClient(): Promise<string> {
  const res = await request(app).post('/oauth/register').send({
    client_name: 'Test Client',
    redirect_uris: ['https://example.test/cb'],
  });
  return res.body.client_id;
}

describe('GET /oauth/authorize', () => {
  it('rejects requests with no client_id', async () => {
    const res = await request(app).get('/oauth/authorize').query({ response_type: 'code' });
    expect(res.status).toBe(400);
    expect(res.text).toContain('client_id is required');
  });

  it('rejects unknown client_id', async () => {
    const res = await request(app).get('/oauth/authorize').query({
      response_type: 'code',
      client_id: 'bogus',
      redirect_uri: 'https://example.test/cb',
      code_challenge: 'x',
      code_challenge_method: 'S256',
    });
    expect(res.status).toBe(400);
    expect(res.text).toContain('unknown client_id');
  });

  it('rejects redirect_uri that does not match registered URI', async () => {
    const clientId = await registerTestClient();
    const res = await request(app).get('/oauth/authorize').query({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://attacker.test/cb',
      code_challenge: 'x',
      code_challenge_method: 'S256',
    });
    expect(res.status).toBe(400);
    expect(res.text).toContain('redirect_uri');
  });

  it('rejects missing PKCE challenge', async () => {
    const clientId = await registerTestClient();
    const res = await request(app).get('/oauth/authorize').query({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://example.test/cb',
    });
    expect(res.status).toBe(400);
    expect(res.text).toContain('code_challenge');
  });

  it('renders login page when no session cookie is present', async () => {
    const clientId = await registerTestClient();
    const { challenge } = makePkce();
    const res = await request(app).get('/oauth/authorize').query({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://example.test/cb',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'mcp',
      state: 'xyz',
    });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Sign in to TREK');
    expect(res.text).toContain('name="password"');
  });

  it('renders consent page when a valid session cookie is present', async () => {
    const clientId = await registerTestClient();
    const { user } = createUser(testDb);
    const { challenge } = makePkce();
    const res = await request(app)
      .get('/oauth/authorize')
      .set('Cookie', authCookie(user.id))
      .query({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: 'https://example.test/cb',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'mcp',
      });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Authorize');
    expect(res.text).toContain(user.email);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end: authorize → token → /mcp
// ─────────────────────────────────────────────────────────────────────────────

describe('End-to-end authorization code + PKCE flow', () => {
  it('approves, exchanges code, and the access token authorizes /mcp', async () => {
    const clientId = await registerTestClient();
    const { user } = createUser(testDb);
    const { verifier, challenge } = makePkce();

    // GET /oauth/authorize to retrieve the csrf_state token.
    const getRes = await request(app)
      .get('/oauth/authorize')
      .set('Cookie', authCookie(user.id))
      .query({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: 'https://example.test/cb',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'mcp',
        state: 'hello',
      });
    const csrfMatch = getRes.text.match(/name="csrf_state" value="([^"]+)"/);
    expect(csrfMatch).toBeTruthy();
    const csrfState = csrfMatch![1];

    // POST approve → expect 302 to redirect_uri with code + state.
    const approveRes = await request(app)
      .post('/oauth/authorize')
      .set('Cookie', authCookie(user.id))
      .type('form')
      .send({ action: 'approve', csrf_state: csrfState });
    expect(approveRes.status).toBe(302);
    const location = approveRes.headers.location as string;
    expect(location).toContain('https://example.test/cb');
    const url = new URL(location);
    const code = url.searchParams.get('code');
    expect(code).toBeTruthy();
    expect(url.searchParams.get('state')).toBe('hello');

    // Exchange the code at /oauth/token with PKCE verifier.
    const tokenRes = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'https://example.test/cb',
      client_id: clientId,
      code_verifier: verifier,
    });
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.body.token_type).toBe('Bearer');
    expect(tokenRes.body.access_token).toBeTruthy();
    expect(tokenRes.body.refresh_token).toBeTruthy();
    expect(tokenRes.body.scope).toBe('mcp');

    // Access token authenticates against /mcp.
    const mcpRes = await request(app).post('/mcp')
      .set('Authorization', `Bearer ${tokenRes.body.access_token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    expect(mcpRes.status).toBe(200);
  });

  it('rejects code exchange with a wrong code_verifier (PKCE check)', async () => {
    const clientId = await registerTestClient();
    const { user } = createUser(testDb);
    const { verifier, challenge } = makePkce();

    const getRes = await request(app)
      .get('/oauth/authorize')
      .set('Cookie', authCookie(user.id))
      .query({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: 'https://example.test/cb',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
    const csrfState = getRes.text.match(/name="csrf_state" value="([^"]+)"/)![1];
    const approveRes = await request(app)
      .post('/oauth/authorize')
      .set('Cookie', authCookie(user.id))
      .type('form')
      .send({ action: 'approve', csrf_state: csrfState });
    const code = new URL(approveRes.headers.location).searchParams.get('code')!;

    // Tamper with the verifier.
    const bogus = verifier + 'xx';
    const tokenRes = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'https://example.test/cb',
      client_id: clientId,
      code_verifier: bogus,
    });
    expect(tokenRes.status).toBe(400);
    expect(tokenRes.body.error).toBe('invalid_grant');
  });

  it('rejects reuse of an authorization code', async () => {
    const clientId = await registerTestClient();
    const { user } = createUser(testDb);
    const { verifier, challenge } = makePkce();
    const getRes = await request(app).get('/oauth/authorize').set('Cookie', authCookie(user.id)).query({
      response_type: 'code', client_id: clientId, redirect_uri: 'https://example.test/cb',
      code_challenge: challenge, code_challenge_method: 'S256',
    });
    const csrfState = getRes.text.match(/name="csrf_state" value="([^"]+)"/)![1];
    const approveRes = await request(app).post('/oauth/authorize').set('Cookie', authCookie(user.id))
      .type('form').send({ action: 'approve', csrf_state: csrfState });
    const code = new URL(approveRes.headers.location).searchParams.get('code')!;

    const first = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code', code, redirect_uri: 'https://example.test/cb',
      client_id: clientId, code_verifier: verifier,
    });
    expect(first.status).toBe(200);

    const second = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code', code, redirect_uri: 'https://example.test/cb',
      client_id: clientId, code_verifier: verifier,
    });
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('invalid_grant');
  });

  it('refresh token rotates and revokes the previous one', async () => {
    const clientId = await registerTestClient();
    const { user } = createUser(testDb);
    const { verifier, challenge } = makePkce();
    const getRes = await request(app).get('/oauth/authorize').set('Cookie', authCookie(user.id)).query({
      response_type: 'code', client_id: clientId, redirect_uri: 'https://example.test/cb',
      code_challenge: challenge, code_challenge_method: 'S256',
    });
    const csrfState = getRes.text.match(/name="csrf_state" value="([^"]+)"/)![1];
    const approveRes = await request(app).post('/oauth/authorize').set('Cookie', authCookie(user.id))
      .type('form').send({ action: 'approve', csrf_state: csrfState });
    const code = new URL(approveRes.headers.location).searchParams.get('code')!;
    const tokenRes = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code', code, redirect_uri: 'https://example.test/cb',
      client_id: clientId, code_verifier: verifier,
    });
    const refresh1 = tokenRes.body.refresh_token;

    const rot1 = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'refresh_token', refresh_token: refresh1, client_id: clientId,
    });
    expect(rot1.status).toBe(200);
    const refresh2 = rot1.body.refresh_token;
    expect(refresh2).not.toBe(refresh1);

    // Old refresh token should now be revoked.
    const reuseOld = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'refresh_token', refresh_token: refresh1, client_id: clientId,
    });
    expect(reuseOld.status).toBe(400);
    expect(reuseOld.body.error).toBe('invalid_grant');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scope enforcement
// ─────────────────────────────────────────────────────────────────────────────

describe('Scope enforcement', () => {
  it('MCP-scoped JWT verifies for /mcp but not for /api/auth/me', async () => {
    const { user } = createUser(testDb);
    const mcpToken = mintAccessToken(user.id, 'trek-oauth-test', 'mcp');

    // /mcp accepts it.
    const mcp = await request(app).post('/mcp')
      .set('Authorization', `Bearer ${mcpToken}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
    expect(mcp.status).toBe(200);

    // General app auth rejects it.
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${mcpToken}`);
    expect(me.status).toBe(401);
  });

  it('verifyMcpScopedJwt accepts a legacy (unscoped) session token', () => {
    const { user } = createUser(testDb);
    const legacy = jwt.sign({ id: user.id }, TEST_JWT_SECRET, { expiresIn: '1h', algorithm: 'HS256' });
    const verified = verifyMcpScopedJwt(legacy);
    expect(verified).toBeTruthy();
    expect(verified!.id).toBe(user.id);
  });

  it('verifyMcpScopedJwt rejects a token with non-mcp scope', () => {
    const { user } = createUser(testDb);
    const t = jwt.sign({ id: user.id, scope: 'admin' }, TEST_JWT_SECRET, { expiresIn: '1h', algorithm: 'HS256' });
    expect(verifyMcpScopedJwt(t)).toBeNull();
  });
});
