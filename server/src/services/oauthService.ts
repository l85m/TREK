import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { db } from '../db/database';
import { JWT_SECRET } from '../config';
import { User } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const OAUTH_SCOPE = 'mcp';
const AUTH_CODE_TTL_MS = 10 * 60 * 1000;       // 10 minutes
const ACCESS_TOKEN_TTL_SEC = 60 * 60;          // 1 hour
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(bytes = 32): string {
  return base64url(crypto.randomBytes(bytes));
}

function verifyPkceS256(verifier: string, challenge: string): boolean {
  const computed = base64url(crypto.createHash('sha256').update(verifier).digest());
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(challenge));
}

// ---------------------------------------------------------------------------
// Client registration (RFC 7591)
// ---------------------------------------------------------------------------

export interface ClientRegistration {
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method?: 'none' | 'client_secret_post' | 'client_secret_basic';
}

export interface RegisteredClient {
  client_id: string;
  client_secret?: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: 'none' | 'client_secret_post' | 'client_secret_basic';
  client_id_issued_at: number;
}

export function registerClient(reg: ClientRegistration): RegisteredClient {
  if (!reg.client_name || typeof reg.client_name !== 'string') {
    throw new Error('client_name is required');
  }
  if (!Array.isArray(reg.redirect_uris) || reg.redirect_uris.length === 0) {
    throw new Error('redirect_uris must be a non-empty array');
  }
  for (const uri of reg.redirect_uris) {
    if (typeof uri !== 'string' || !/^https?:\/\//i.test(uri)) {
      throw new Error('redirect_uris entries must be http(s) URLs');
    }
  }
  const authMethod = reg.token_endpoint_auth_method ?? 'none';
  if (!['none', 'client_secret_post', 'client_secret_basic'].includes(authMethod)) {
    throw new Error('unsupported token_endpoint_auth_method');
  }

  const clientId = `trek-oauth-${randomToken(12)}`;
  let clientSecret: string | undefined;
  let clientSecretHash: string | null = null;
  if (authMethod !== 'none') {
    clientSecret = randomToken(32);
    clientSecretHash = bcrypt.hashSync(clientSecret, 10);
  }

  db.prepare(`
    INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method)
    VALUES (?, ?, ?, ?, ?)
  `).run(clientId, clientSecretHash, reg.client_name, JSON.stringify(reg.redirect_uris), authMethod);

  return {
    client_id: clientId,
    client_secret: clientSecret,
    client_name: reg.client_name,
    redirect_uris: reg.redirect_uris,
    token_endpoint_auth_method: authMethod,
    client_id_issued_at: Math.floor(Date.now() / 1000),
  };
}

interface ClientRow {
  client_id: string;
  client_secret_hash: string | null;
  client_name: string;
  redirect_uris: string;
  token_endpoint_auth_method: string;
}

export function getClient(clientId: string): ClientRow | null {
  const row = db.prepare('SELECT client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method FROM oauth_clients WHERE client_id = ?').get(clientId) as ClientRow | undefined;
  return row ?? null;
}

export function clientRedirectUris(row: ClientRow): string[] {
  try { return JSON.parse(row.redirect_uris); } catch { return []; }
}

export function authenticateClient(clientId: string, clientSecret: string | undefined): ClientRow | null {
  const row = getClient(clientId);
  if (!row) return null;
  if (row.token_endpoint_auth_method === 'none') {
    // Public client: no secret expected. PKCE is the proof of possession.
    return row;
  }
  if (!clientSecret || !row.client_secret_hash) return null;
  if (!bcrypt.compareSync(clientSecret, row.client_secret_hash)) return null;
  return row;
}

// ---------------------------------------------------------------------------
// Authorization codes
// ---------------------------------------------------------------------------

export interface IssueCodeArgs {
  clientId: string;
  userId: number;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
}

export function issueAuthorizationCode(args: IssueCodeArgs): string {
  if (args.codeChallengeMethod !== 'S256') {
    throw new Error('only S256 code_challenge_method is supported');
  }
  const code = randomToken(32);
  const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_MS).toISOString();
  db.prepare(`
    INSERT INTO oauth_auth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, code_challenge_method, scope, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sha256(code), args.clientId, args.userId, args.redirectUri, args.codeChallenge, args.codeChallengeMethod, args.scope, expiresAt);
  return code;
}

interface AuthCodeRow {
  id: number;
  client_id: string;
  user_id: number;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string;
  expires_at: string;
  used: number;
}

export interface RedeemResult {
  userId: number;
  clientId: string;
  scope: string;
}

export function redeemAuthorizationCode(params: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
}): RedeemResult {
  const row = db.prepare('SELECT id, client_id, user_id, redirect_uri, code_challenge, code_challenge_method, scope, expires_at, used FROM oauth_auth_codes WHERE code_hash = ?')
    .get(sha256(params.code)) as AuthCodeRow | undefined;

  if (!row) throw new Error('invalid_grant');
  if (row.used) {
    // Code replay: invalidate the row and refuse. (Spec: revoke related tokens, too.)
    db.prepare('UPDATE oauth_auth_codes SET used = 1 WHERE id = ?').run(row.id);
    throw new Error('invalid_grant');
  }
  if (new Date(row.expires_at).getTime() < Date.now()) throw new Error('invalid_grant');
  if (row.client_id !== params.clientId) throw new Error('invalid_grant');
  if (row.redirect_uri !== params.redirectUri) throw new Error('invalid_grant');
  if (!verifyPkceS256(params.codeVerifier, row.code_challenge)) throw new Error('invalid_grant');

  db.prepare('UPDATE oauth_auth_codes SET used = 1 WHERE id = ?').run(row.id);
  return { userId: row.user_id, clientId: row.client_id, scope: row.scope };
}

// ---------------------------------------------------------------------------
// Access + refresh tokens
// ---------------------------------------------------------------------------

export function mintAccessToken(userId: number, clientId: string, scope: string): string {
  return jwt.sign(
    { id: userId, scope, client_id: clientId },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL_SEC, algorithm: 'HS256' }
  );
}

export function issueRefreshToken(userId: number, clientId: string, scope: string): string {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString();
  db.prepare(`
    INSERT INTO oauth_refresh_tokens (token_hash, client_id, user_id, scope, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(sha256(token), clientId, userId, scope, expiresAt);
  return token;
}

interface RefreshRow {
  id: number;
  client_id: string;
  user_id: number;
  scope: string;
  expires_at: string;
  revoked: number;
}

export function redeemRefreshToken(params: { refreshToken: string; clientId: string }): RedeemResult {
  const row = db.prepare('SELECT id, client_id, user_id, scope, expires_at, revoked FROM oauth_refresh_tokens WHERE token_hash = ?')
    .get(sha256(params.refreshToken)) as RefreshRow | undefined;
  if (!row) throw new Error('invalid_grant');
  if (row.revoked) throw new Error('invalid_grant');
  if (new Date(row.expires_at).getTime() < Date.now()) throw new Error('invalid_grant');
  if (row.client_id !== params.clientId) throw new Error('invalid_grant');
  return { userId: row.user_id, clientId: row.client_id, scope: row.scope };
}

export function revokeRefreshToken(refreshToken: string): void {
  db.prepare('UPDATE oauth_refresh_tokens SET revoked = 1 WHERE token_hash = ?').run(sha256(refreshToken));
}

// ---------------------------------------------------------------------------
// Access token verification (used by MCP handler)
// ---------------------------------------------------------------------------

export function verifyMcpScopedJwt(token: string): User | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as { id: number; scope?: string };
    // Accept either: a legacy session JWT (no scope) or an OAuth MCP-scoped token.
    if (decoded.scope && decoded.scope !== OAUTH_SCOPE) return null;
    const user = db.prepare('SELECT id, username, email, role FROM users WHERE id = ?').get(decoded.id) as User | undefined;
    return user ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Background cleanup (expired auth codes + refresh tokens)
// ---------------------------------------------------------------------------

export function cleanupExpiredOAuthArtifacts(): void {
  const now = new Date().toISOString();
  db.prepare('DELETE FROM oauth_auth_codes WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM oauth_refresh_tokens WHERE expires_at < ? OR revoked = 1').run(now);
}
