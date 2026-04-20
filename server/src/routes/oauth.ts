import express, { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { db } from '../db/database';
import { JWT_SECRET } from '../config';
import { writeAudit, getClientIp } from '../services/auditLog';
import { setAuthCookie } from '../services/cookie';
import { extractToken } from '../middleware/auth';
import { generateToken } from '../services/authService';
import {
  registerClient,
  getClient,
  clientRedirectUris,
  authenticateClient,
  issueAuthorizationCode,
  redeemAuthorizationCode,
  mintAccessToken,
  issueRefreshToken,
  redeemRefreshToken,
  revokeRefreshToken,
  OAUTH_SCOPE,
} from '../services/oauthService';
import { User } from '../types';

const router = express.Router();

// Override helmet's app-wide CSP for OAuth routes so the 302 redirect back to
// the client's redirect_uri (e.g. https://claude.ai/api/mcp/auth_callback)
// isn't blocked by form-action 'self'. Browsers enforce form-action against
// the originating page's CSP on both the initial submit AND on redirects.
router.use((req: Request, res: Response, next) => {
  const fromQuery = typeof req.query.redirect_uri === 'string' ? req.query.redirect_uri : undefined;
  const body = req.body as Record<string, unknown> | undefined;
  const fromBody = body && typeof body.redirect_uri === 'string' ? (body.redirect_uri as string) : undefined;
  setOAuthCsp(res, fromQuery ?? fromBody);
  next();
});

// ---------------------------------------------------------------------------
// Dynamic Client Registration (RFC 7591)
// ---------------------------------------------------------------------------

router.post('/register', (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    const registered = registerClient({
      client_name: body.client_name,
      redirect_uris: body.redirect_uris,
      token_endpoint_auth_method: body.token_endpoint_auth_method,
    });
    writeAudit({
      userId: null,
      action: 'oauth.client_register',
      details: { client_id: registered.client_id, client_name: registered.client_name },
      ip: getClientIp(req),
    });
    res.status(201).json(registered);
  } catch (err) {
    res.status(400).json({ error: 'invalid_client_metadata', error_description: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Authorization endpoint
// ---------------------------------------------------------------------------

interface AuthorizeParams {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string;
  state: string;
}

function parseAuthorizeParams(source: Record<string, unknown>): Partial<AuthorizeParams> {
  const pick = (k: keyof AuthorizeParams) => (typeof source[k] === 'string' ? (source[k] as string) : undefined);
  return {
    response_type: pick('response_type'),
    client_id: pick('client_id'),
    redirect_uri: pick('redirect_uri'),
    code_challenge: pick('code_challenge'),
    code_challenge_method: pick('code_challenge_method'),
    scope: pick('scope'),
    state: pick('state'),
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/**
 * Override helmet's default CSP for OAuth pages so the form's 302 redirect to
 * the client's redirect_uri isn't blocked by form-action 'self'. Without this,
 * Chrome silently drops the redirect to e.g. https://claude.ai/api/mcp/auth_callback.
 */
function setOAuthCsp(res: Response, redirectUri?: string): void {
  const allowed = ["'self'"];
  if (redirectUri) {
    try { allowed.push(new URL(redirectUri).origin); } catch { /* ignore bad URI */ }
  }
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'none'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "object-src 'none'",
      "base-uri 'self'",
      `form-action ${allowed.join(' ')}`,
      "frame-ancestors 'none'",
    ].join('; '),
  );
}

function renderPage(title: string, body: string, errorMsg?: string): string {
  const err = errorMsg
    ? `<div style="background:#fee;border:1px solid #fcc;color:#900;padding:10px;border-radius:6px;margin-bottom:16px">${escapeHtml(errorMsg)}</div>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — TREK</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f8fafc;color:#0f172a;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:28px;max-width:420px;width:100%;box-shadow:0 8px 24px rgba(0,0,0,.05)}
  h1{margin:0 0 4px;font-size:20px;font-weight:600}
  p{margin:0 0 16px;color:#475569;font-size:14px;line-height:1.5}
  label{display:block;margin-bottom:8px;font-size:13px;font-weight:500}
  input[type=email],input[type=password]{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;margin-bottom:14px}
  button{background:#0f172a;color:#fff;border:0;border-radius:8px;padding:11px 16px;font-size:14px;font-weight:600;cursor:pointer;width:100%}
  button.secondary{background:#e2e8f0;color:#0f172a;margin-top:8px}
  button:hover{opacity:.92}
  .client{background:#f1f5f9;padding:10px 12px;border-radius:8px;font-size:13px;margin-bottom:14px}
  .client b{color:#0f172a}
  .scopes{font-size:13px;color:#475569;margin-bottom:16px}
  .scopes li{margin:2px 0}
  .brand{font-size:12px;color:#94a3b8;text-align:center;margin-top:20px}
</style>
</head>
<body>
<div class="card">
  <h1>${escapeHtml(title)}</h1>
  ${err}
  ${body}
  <div class="brand">TREK · OAuth 2.1</div>
</div>
</body>
</html>`;
}

function findUserFromCookie(req: Request): User | null {
  const token = extractToken(req);
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as { id: number; scope?: string };
    // Only legacy session JWTs (no scope) can log a user in for OAuth UI.
    if (decoded.scope) return null;
    const user = db.prepare('SELECT id, username, email, role FROM users WHERE id = ?').get(decoded.id) as User | undefined;
    return user ?? null;
  } catch {
    return null;
  }
}

function mintAuthorizeCsrf(userId: number, p: AuthorizeParams): string {
  return jwt.sign(
    {
      purpose: 'oauth_authorize',
      u: userId,
      c: p.client_id,
      r: p.redirect_uri,
      cc: p.code_challenge,
      ccm: p.code_challenge_method,
      s: p.scope,
      st: p.state ?? '',
    },
    JWT_SECRET,
    { expiresIn: '10m', algorithm: 'HS256' },
  );
}

function verifyAuthorizeCsrf(token: string, userId: number): AuthorizeParams | null {
  try {
    const d = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as {
      purpose: string; u: number; c: string; r: string; cc: string; ccm: string; s: string; st: string;
    };
    if (d.purpose !== 'oauth_authorize' || d.u !== userId) return null;
    return {
      response_type: 'code',
      client_id: d.c,
      redirect_uri: d.r,
      code_challenge: d.cc,
      code_challenge_method: d.ccm,
      scope: d.s,
      state: d.st,
    };
  } catch {
    return null;
  }
}

function renderLoginForm(p: AuthorizeParams, errorMsg?: string): string {
  const hiddens = (Object.entries(p) as [string, string][]).map(
    ([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v ?? '')}">`
  ).join('\n  ');
  return renderPage(
    'Sign in to TREK',
    `<p>Sign in to authorize this connection.</p>
<form method="POST" action="/oauth/authorize">
  <input type="hidden" name="action" value="login">
  ${hiddens}
  <label for="email">Email</label>
  <input id="email" type="email" name="email" autocomplete="email" required>
  <label for="password">Password</label>
  <input id="password" type="password" name="password" autocomplete="current-password" required>
  <button type="submit">Sign in</button>
</form>`,
    errorMsg,
  );
}

function renderConsentForm(user: User, clientName: string, csrf: string, scope: string): string {
  return renderPage(
    'Authorize access',
    `<div class="client"><b>${escapeHtml(clientName)}</b> wants to connect to your TREK account.</div>
<p>Signed in as <b>${escapeHtml(user.email)}</b>.</p>
<div class="scopes">This app will be able to:
  <ul>
    <li>Read and modify your trips, reservations, tasks, and notes</li>
    <li>Access files attached to your trips</li>
  </ul>
</div>
<form method="POST" action="/oauth/authorize">
  <input type="hidden" name="csrf_state" value="${escapeHtml(csrf)}">
  <input type="hidden" name="action" value="approve">
  <button type="submit">Authorize</button>
</form>
<form method="POST" action="/oauth/authorize" style="margin-top:8px">
  <input type="hidden" name="csrf_state" value="${escapeHtml(csrf)}">
  <input type="hidden" name="action" value="deny">
  <button type="submit" class="secondary">Deny</button>
</form>`,
  );
}

function redirectWithParams(res: Response, base: string, params: Record<string, string>): void {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  res.redirect(302, url.toString());
}

class AuthorizeValidationError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

interface ValidatedAuthorize {
  p: AuthorizeParams;
  clientName: string;
}

function validateAuthorizeRequest(params: Partial<AuthorizeParams>): ValidatedAuthorize {
  if (params.response_type !== 'code') throw new AuthorizeValidationError('unsupported_response_type');
  if (!params.client_id) throw new AuthorizeValidationError('client_id is required');
  if (!params.redirect_uri) throw new AuthorizeValidationError('redirect_uri is required');
  if (!params.code_challenge) throw new AuthorizeValidationError('code_challenge is required (PKCE is mandatory)');
  if (params.code_challenge_method !== 'S256') throw new AuthorizeValidationError('code_challenge_method must be S256');
  const row = getClient(params.client_id);
  if (!row) throw new AuthorizeValidationError('unknown client_id');
  const registered = clientRedirectUris(row);
  if (!registered.includes(params.redirect_uri)) throw new AuthorizeValidationError('redirect_uri does not match any registered URI');
  const scope = params.scope ?? OAUTH_SCOPE;
  if (scope !== OAUTH_SCOPE) throw new AuthorizeValidationError(`unsupported scope (must be "${OAUTH_SCOPE}")`);
  return {
    p: {
      response_type: 'code',
      client_id: params.client_id,
      redirect_uri: params.redirect_uri,
      code_challenge: params.code_challenge,
      code_challenge_method: 'S256',
      scope,
      state: params.state ?? '',
    },
    clientName: row.client_name,
  };
}

function sendAuthorizeError(res: Response, err: unknown): void {
  if (err instanceof AuthorizeValidationError) {
    res.status(err.status).type('html').send(renderPage('Authorization error', `<p>${escapeHtml(err.message)}</p>`));
    return;
  }
  res.status(500).type('html').send(renderPage('Authorization error', '<p>Unexpected error.</p>'));
}

router.get('/authorize', (req: Request, res: Response) => {
  let validated: ValidatedAuthorize;
  try {
    validated = validateAuthorizeRequest(parseAuthorizeParams(req.query as Record<string, unknown>));
  } catch (err) {
    sendAuthorizeError(res, err);
    return;
  }

  const user = findUserFromCookie(req);
  if (!user) {
    res.type('html').send(renderLoginForm(validated.p));
    return;
  }

  const csrf = mintAuthorizeCsrf(Number(user.id), validated.p);
  res.type('html').send(renderConsentForm(user, validated.clientName, csrf, validated.p.scope));
});

router.post('/authorize', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const action = typeof body.action === 'string' ? body.action : '';

  // -------- login action: credentials flow embedded in the oauth page --------
  if (action === 'login') {
    let validated: ValidatedAuthorize;
    try {
      validated = validateAuthorizeRequest(parseAuthorizeParams(body));
    } catch (err) {
      sendAuthorizeError(res, err);
      return;
    }
    const email = typeof body.email === 'string' ? body.email : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email || !password) {
      res.status(400).type('html').send(renderLoginForm(validated.p, 'Email and password are required.'));
      return;
    }

    const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)').get(email) as User | undefined;
    if (!user || !user.password_hash || !bcrypt.compareSync(password, user.password_hash)) {
      writeAudit({
        userId: user ? Number(user.id) : null,
        action: 'oauth.login_failed',
        details: { email, reason: user ? 'wrong_password' : 'unknown_email' },
        ip: getClientIp(req),
      });
      res.status(401).type('html').send(renderLoginForm(validated.p, 'Invalid email or password.'));
      return;
    }
    if (user.mfa_enabled === 1 || user.mfa_enabled === true) {
      res.status(400).type('html').send(renderLoginForm(
        validated.p,
        'This account has MFA enabled. Sign in to TREK in the main app first, then retry the connection.',
      ));
      return;
    }
    if (user.must_change_password === 1 || user.must_change_password === true) {
      res.status(400).type('html').send(renderLoginForm(
        validated.p,
        'You must change your password in the main app before connecting an OAuth client.',
      ));
      return;
    }

    setAuthCookie(res, generateToken(user));
    const csrf = mintAuthorizeCsrf(Number(user.id), validated.p);
    const clientRow = getClient(validated.p.client_id);
    const clientName = clientRow?.client_name ?? validated.p.client_id;
    res.type('html').send(renderConsentForm(user, clientName, csrf, validated.p.scope));
    return;
  }

  // -------- approve/deny: finalize the authorization --------
  const user = findUserFromCookie(req);
  if (!user) {
    res.status(401).type('html').send(renderPage('Session expired', '<p>Please reload the page and sign in again.</p>'));
    return;
  }

  const csrfTok = typeof body.csrf_state === 'string' ? body.csrf_state : '';
  const p = verifyAuthorizeCsrf(csrfTok, Number(user.id));
  if (!p) {
    res.status(400).type('html').send(renderPage('Authorization error', '<p>Session expired or invalid request. Reload and try again.</p>'));
    return;
  }

  // Re-validate the client + redirect_uri in case the client was deleted mid-flow.
  try {
    validateAuthorizeRequest(p);
  } catch (err) {
    sendAuthorizeError(res, err);
    return;
  }

  if (action === 'deny') {
    writeAudit({ userId: Number(user.id), action: 'oauth.authorize_denied', resource: p.client_id, ip: getClientIp(req) });
    redirectWithParams(res, p.redirect_uri, { error: 'access_denied', state: p.state });
    return;
  }

  if (action !== 'approve') {
    res.status(400).type('html').send(renderPage('Authorization error', '<p>Unknown action.</p>'));
    return;
  }

  const code = issueAuthorizationCode({
    clientId: p.client_id,
    userId: Number(user.id),
    redirectUri: p.redirect_uri,
    codeChallenge: p.code_challenge,
    codeChallengeMethod: p.code_challenge_method,
    scope: p.scope,
  });
  writeAudit({
    userId: Number(user.id),
    action: 'oauth.authorize_approved',
    resource: p.client_id,
    ip: getClientIp(req),
  });
  redirectWithParams(res, p.redirect_uri, { code, state: p.state });
});

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

function extractBasicAuth(req: Request): { clientId?: string; clientSecret?: string } {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Basic ')) return {};
  try {
    const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return {};
    return { clientId: decoded.slice(0, idx), clientSecret: decoded.slice(idx + 1) };
  } catch {
    return {};
  }
}

router.post('/token', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const grant_type = typeof body.grant_type === 'string' ? body.grant_type : '';

  const basic = extractBasicAuth(req);
  const clientId = (typeof body.client_id === 'string' ? body.client_id : '') || basic.clientId || '';
  const clientSecret = (typeof body.client_secret === 'string' ? body.client_secret : '') || basic.clientSecret || '';

  if (!clientId) {
    res.status(400).json({ error: 'invalid_client', error_description: 'client_id required' });
    return;
  }
  const client = authenticateClient(clientId, clientSecret || undefined);
  if (!client) {
    res.status(401).json({ error: 'invalid_client' });
    return;
  }

  try {
    if (grant_type === 'authorization_code') {
      const code = typeof body.code === 'string' ? body.code : '';
      const redirectUri = typeof body.redirect_uri === 'string' ? body.redirect_uri : '';
      const codeVerifier = typeof body.code_verifier === 'string' ? body.code_verifier : '';
      if (!code || !redirectUri || !codeVerifier) {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      const redeemed = redeemAuthorizationCode({ code, clientId, redirectUri, codeVerifier });
      const access_token = mintAccessToken(redeemed.userId, redeemed.clientId, redeemed.scope);
      const refresh_token = issueRefreshToken(redeemed.userId, redeemed.clientId, redeemed.scope);
      writeAudit({ userId: redeemed.userId, action: 'oauth.token_issued', resource: clientId, ip: getClientIp(req) });
      res.json({
        access_token,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token,
        scope: redeemed.scope,
      });
      return;
    }

    if (grant_type === 'refresh_token') {
      const refresh_token = typeof body.refresh_token === 'string' ? body.refresh_token : '';
      if (!refresh_token) {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      const redeemed = redeemRefreshToken({ refreshToken: refresh_token, clientId });
      // Rotate: revoke old refresh token, issue a new one.
      revokeRefreshToken(refresh_token);
      const newRefresh = issueRefreshToken(redeemed.userId, redeemed.clientId, redeemed.scope);
      const access_token = mintAccessToken(redeemed.userId, redeemed.clientId, redeemed.scope);
      res.json({
        access_token,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: newRefresh,
        scope: redeemed.scope,
      });
      return;
    }

    res.status(400).json({ error: 'unsupported_grant_type' });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === 'invalid_grant') {
      res.status(400).json({ error: 'invalid_grant' });
      return;
    }
    res.status(400).json({ error: 'invalid_request', error_description: msg });
  }
});

// ---------------------------------------------------------------------------
// Token revocation (RFC 7009) — refresh tokens only; access tokens are JWTs
// and expire quickly.
// ---------------------------------------------------------------------------

router.post('/revoke', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const token = typeof body.token === 'string' ? body.token : '';
  if (token) revokeRefreshToken(token);
  // Per RFC 7009, always return 200 regardless of whether the token existed.
  res.status(200).end();
});

export default router;
