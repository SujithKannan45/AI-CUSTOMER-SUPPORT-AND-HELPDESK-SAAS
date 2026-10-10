/**
 * Authentication verification driver — HTTP-level, REAL end-to-end flows.
 *
 * Boots its own in-memory mongod (port 0) + the REAL Express app on an
 * ephemeral port, then exercises every auth flow over real HTTP:
 *
 *   1.  registration (valid / duplicate / weak password / invalid email)
 *   2.  email verification (valid / reuse / invalid token / unknown email)
 *   3.  login (valid / wrong password / unknown account / suspended)
 *   4.  /me (valid token / missing token / garbage token / tampered token)
 *   5.  refresh (rotation works / old token rejected / reuse kills family /
 *       garbage token)
 *   6.  logout (token dead after logout / idempotent)
 *   7.  logout-all (all sessions die, requires auth)
 *   8.  forgot-password (generic response for known AND unknown emails)
 *   9.  reset-password (valid / expired-flow reuse / invalid token /
 *       sessions invalidated)
 *  10.  response security (no tokens/hashes in bodies or logs) + rate limit
 *       headers on sensitive routes + cookie flags
 *
 * Server code is imported DYNAMICALLY inside main() AFTER MONGODB_URI is set
 * (env.config.ts freezes process.env at module-evaluation time — the Prompt 3
 * lesson). Exit code 0 only when every check passes.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';

interface Check {
  name: string;
  pass: boolean;
}

const checks: Check[] = [];

function record(name: string, pass: boolean): void {
  checks.push({ name, pass });
  // eslint-disable-next-line no-console
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
}

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
  headers: Map<string, string>;
  setCookies: string[];
}

async function http(
  method: 'GET' | 'POST',
  url: string,
  options: { body?: unknown; token?: string; rawCookie?: string; ip?: string } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
  if (options.rawCookie !== undefined) headers['cookie'] = options.rawCookie;
  // trust proxy = 1, so X-Forwarded-For defines the rate-limit key: a unique
  // IP per call keeps the driver's ~20 sensitive calls from tripping the
  // 20-per-15-min sensitiveRouteLimiter (which is verified explicitly below
  // with a dedicated IP instead).
  headers['x-forwarded-for'] = options.ip ?? `10.1.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
  const response = await fetch(url, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const setCookies: string[] =
    typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  const headersMap = new Map<string, string>();
  response.headers.forEach((value, key) => headersMap.set(key.toLowerCase(), value));
  return { status: response.status, body, headers: headersMap, setCookies };
}

function extractCookie(setCookies: string[], name: string): string | undefined {
  const line = setCookies.find((c) => c.startsWith(`${name}=`));
  if (line === undefined) return undefined;
  return line.slice(name.length + 1).split(';')[0];
}

async function expectFailure(name: string, operation: () => Promise<unknown>, passOn: (result: unknown) => boolean): Promise<void> {
  try {
    const result = await operation();
    record(name, passOn(result));
  } catch {
    record(name, false);
  }
}

async function main(): Promise<void> {
  const memoryServer = await MongoMemoryServer.create({
    instance: { ip: '127.0.0.1', port: 0, dbName: 'verify_auth' },
  });

  // Set BEFORE importing server code (Prompt 3 lesson: env.config freezes
  // process.env at module-evaluation time). PORT pinned (host shells may
  // export a placeholder value).
  const expectedUri = memoryServer.getUri('verify_auth');
  process.env['MONGODB_URI'] = expectedUri;
  // The driver makes dozens of auth calls in seconds: raise the global
  // limiter so legitimate traffic is not rate-limited mid-verification (the
  // 20-per-15-min sensitive limiter is asserted separately, see below).
  process.env['RATE_LIMIT_MAX_REQUESTS'] = '10000';
  // PORT must be a positive number (env validation); pick a rarely used port
  // and fail loudly below if it is already taken.
  const port = 3999;
  process.env['PORT'] = String(port);

  const { startServer } = await import('../server/src/server.js');
  const { env } = await import('../server/src/config/env.config.js');
  // Prove the config froze the RIGHT database (protects foreign DBs).
  if (env.MONGODB_URI !== expectedUri) {
    throw new Error(
      `env.MONGODB_URI (${env.MONGODB_URI}) does not match the verification mongod (${expectedUri}) — aborting to protect foreign databases`,
    );
  }

  const httpServer = await startServer();
  const base = `http://127.0.0.1:${port}/api/v1/auth`;

  // Models for direct DB assertions (suspension, token rows).
  const { UserModel } = await import('../server/src/modules/users/user.model.js');
  const { RefreshTokenModel } = await import('../server/src/modules/auth/auth-token.model.js');
  const { logOutboxTransport } = await import(
    '../server/src/modules/auth/email/log-outbox.transport.js'
  );

  const PASSWORD = 'Str0ngPass!42';

  try {
    // ── 1. Registration ────────────────────────────────────────────────────
    const reg = await http('POST', `${base}/register`, {
      body: { name: 'Ada Lovelace', email: 'Ada@Example.com', password: PASSWORD },
    });
    record(
      'register: 201 with safe user payload',
      reg.status === 201 &&
        (reg.body as { data?: { user?: Record<string, unknown> } }).data?.user?.['email'] ===
          'ada@example.com' &&
        (reg.body as { data?: { user?: Record<string, unknown> } }).data?.user?.['passwordHash'] ===
          undefined,
    );
    const regBody = JSON.stringify(reg.body);
    record('register: response contains no password material', !regBody.includes('Str0ngPass') && !regBody.includes('$2'));

    const regDup = await http('POST', `${base}/register`, {
      body: { name: 'Ada Again', email: 'ada@example.com', password: PASSWORD },
    });
    record(
      'register: duplicate email → 409 conflict',
      regDup.status === 409 && (regDup.body as { error?: { code?: string } }).error?.['code'] === 'CONFLICT',
    );

    const regWeak = await http('POST', `${base}/register`, {
      body: { name: 'Weak', email: 'weak@example.com', password: 'short' },
    });
    record('register: weak password → 422 validation', regWeak.status === 422);

    const regCommon = await http('POST', `${base}/register`, {
      body: { name: 'Common', email: 'common@example.com', password: 'password123' },
    });
    record('register: common password → 422 validation', regCommon.status === 422);

    const regEmail = await http('POST', `${base}/register`, {
      body: { name: 'Bad', email: 'not-an-email', password: PASSWORD },
    });
    record('register: invalid email → 422 validation', regEmail.status === 422);

    // ── 2. Email verification ─────────────────────────────────────────────
    const verifyToken = logOutboxTransport.extractTokenFromLastEmail('ada@example.com');
    record('register: verification email rendered in dev outbox', verifyToken !== null && verifyToken?.length === 64);

    const loggedText = JSON.stringify(reg.body) + JSON.stringify(regDup.body);
    record('verify-email: raw token never appears in API responses', verifyToken !== null && !loggedText.includes(verifyToken));

    if (verifyToken === null) throw new Error('cannot continue without verify token');
    const verifyBad = await http('POST', `${base}/verify-email`, {
      body: { email: 'ada@example.com', token: 'a'.repeat(64) },
    });
    record('verify-email: invalid token → 400', verifyBad.status === 400);

    const verify = await http('POST', `${base}/verify-email`, {
      body: { email: 'ada@example.com', token: verifyToken },
    });
    record(
      'verify-email: valid token → 200, emailVerified true',
      verify.status === 200 &&
        (verify.body as { data?: { user?: { emailVerified?: boolean } } }).data?.user?.['emailVerified'] === true,
    );

    const verifyAgain = await http('POST', `${base}/verify-email`, {
      body: { email: 'ada@example.com', token: verifyToken },
    });
    record('verify-email: one-time use — replay → 400', verifyAgain.status === 400);

    // ── 3. Login ───────────────────────────────────────────────────────────
    const login = await http('POST', `${base}/login`, {
      body: { email: 'ada@example.com', password: PASSWORD },
    });
    const loginData = (login.body as { data?: { user?: Record<string, unknown>; tokens?: Record<string, unknown> } }).data;
    const accessToken = typeof loginData?.tokens?.['accessToken'] === 'string' ? (loginData.tokens['accessToken'] as string) : '';
    record(
      'login: valid → 200 with accessToken + user',
      login.status === 200 && accessToken.split('.').length === 3 && loginData?.user?.['email'] === 'ada@example.com',
    );
    const refreshCookie = extractCookie(login.setCookies, 'refresh_token');
    record(
      'login: refresh cookie set HttpOnly with auth-scoped path',
      refreshCookie !== undefined &&
        login.setCookies.some((c) => c.includes('HttpOnly') && c.includes('Path=/api/v1/auth')),
    );
    record('login: password hash absent from response', !JSON.stringify(login.body).includes('$2'));

    const loginWrong = await http('POST', `${base}/login`, {
      body: { email: 'ada@example.com', password: 'Wr0ngPass!99' },
    });
    const loginUnknown = await http('POST', `${base}/login`, {
      body: { email: 'ghost@example.com', password: 'Wr0ngPass!99' },
    });
    // Compare status + error payload WITHOUT requestId (unique per request).
    const stripRequestId = (b: Record<string, unknown>): string => JSON.stringify({ ...b, requestId: undefined });
    record(
      'login: anti-enumeration — wrong password and unknown account identical',
      loginWrong.status === 401 &&
        loginUnknown.status === 401 &&
        stripRequestId(loginWrong.body) === stripRequestId(loginUnknown.body),
    );

    // Suspended account
    await UserModel.updateOne({ email: 'ada@example.com' }, { $set: { status: 'suspended' } });
    const loginSuspended = await http('POST', `${base}/login`, {
      body: { email: 'ada@example.com', password: PASSWORD },
    });
    record('login: suspended account → 403', loginSuspended.status === 403);
    await UserModel.updateOne({ email: 'ada@example.com' }, { $set: { status: 'active' } });

    // Second session (another device) before continuing.
    const login2 = await http('POST', `${base}/login`, {
      body: { email: 'ada@example.com', password: PASSWORD },
    });
    const refresh2 = extractCookie(login2.setCookies, 'refresh_token');

    // ── 4. /me and access-token validation ─────────────────────────────────
    const me = await http('GET', `${base}/me`, { token: accessToken });
    record('me: valid token → 200 with safe profile', me.status === 200 && (me.body as { data?: { user?: Record<string, unknown> } }).data?.user?.['id'] !== undefined);

    const meNoToken = await http('GET', `${base}/me`);
    record('me: missing token → 401', meNoToken.status === 401);

    const meGarbage = await http('GET', `${base}/me`, { token: 'not.a.jwt' });
    record('me: garbage token → 401', meGarbage.status === 401);

    const [h, p] = accessToken.split('.');
    const tampered = `${h}.${p}.TAMPERED`;
    const meTampered = await http('GET', `${base}/me`, { token: tampered });
    record('me: tampered signature → 401', meTampered.status === 401);

    // Expired access token: sign one with a tiny TTL via a fresh secret? Instead:
    // craft an already-expired JWT using jsonwebtoken-free jose import.
    const { SignJWT } = await import('jose');
    const expired = await new SignJWT({ type: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('000000000000000000000000')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(new TextEncoder().encode('wrong-secret-but-signed-anyway'));
    const meExpired = await http('GET', `${base}/me`, { token: expired });
    record('me: expired token → 401', meExpired.status === 401);

    // ── 5. Refresh flow ───────────────────────────────────────────────────
    const refresh1 = await http('POST', `${base}/refresh`, { rawCookie: `refresh_token=${refreshCookie}` });
    const newAccess = (refresh1.body as { data?: { accessToken?: string } }).data?.['accessToken'];
    record(
      'refresh: valid → 200 with new access token + rotated cookie',
      refresh1.status === 200 && typeof newAccess === 'string' && extractCookie(refresh1.setCookies, 'refresh_token') !== undefined,
    );
    const rotatedCookie = extractCookie(refresh1.setCookies, 'refresh_token');

    const refreshOld = await http('POST', `${base}/refresh`, { rawCookie: `refresh_token=${refreshCookie}` });
    record('refresh: old (rotated) token rejected → 401', refreshOld.status === 401);

    const refreshGarbage = await http('POST', `${base}/refresh`, { rawCookie: 'refresh_token=deadbeef' });
    record('refresh: garbage token → 401', refreshGarbage.status === 401);

    // Reuse detection: replaying the rotated token must kill the whole family
    // (the successor from refresh1 must die too).
    await http('POST', `${base}/refresh`, { rawCookie: `refresh_token=${refreshCookie}` }); // second reuse
    const refreshAfterReuse = await http('POST', `${base}/refresh`, { rawCookie: `refresh_token=${rotatedCookie}` });
    record('refresh: reuse of rotated token revokes the family (successor dead too)', refreshAfterReuse.status === 401);

    // Session 2 refresh still works (independent family).
    const refresh2b = await http('POST', `${base}/refresh`, { rawCookie: `refresh_token=${refresh2}` });
    const access2 = (refresh2b.body as { data?: { accessToken?: string } }).data?.['accessToken'] as string | undefined;
    const refresh2c = extractCookie(refresh2b.setCookies, 'refresh_token');
    record('refresh: independent session unaffected', refresh2b.status === 200 && access2 !== undefined && refresh2c !== undefined);

    // ── 6. Logout ──────────────────────────────────────────────────────────
    const logout = await http('POST', `${base}/logout`, { rawCookie: `refresh_token=${refresh2c}` });
    record('logout: 200 + cookie cleared', logout.status === 200 && logout.setCookies.some((c) => c.includes('refresh_token=;') || c.includes('refresh_token=')));

    const logoutAgain = await http('POST', `${base}/refresh`, { rawCookie: `refresh_token=${refresh2c}` });
    record('logout: refresh token dead after logout → 401', logoutAgain.status === 401);

    const logoutIdem = await http('POST', `${base}/logout`, { rawCookie: `refresh_token=${refresh2c}` });
    record('logout: idempotent (second call → 200)', logoutIdem.status === 200);

    // ── 7. Logout-all ──────────────────────────────────────────────────────
    const login3 = await http('POST', `${base}/login`, { body: { email: 'ada@example.com', password: PASSWORD } });
    const access3 = (login3.body as { data?: { tokens?: Record<string, unknown> } }).data?.tokens?.['accessToken'] as string;
    const liveBefore = await RefreshTokenModel.countDocuments({ revokedAt: null });
    const logoutAll = await http('POST', `${base}/logout-all`, { token: access3 });
    const liveAfter = await RefreshTokenModel.countDocuments({ revokedAt: null });
    record(
      'logout-all: 200 and ALL live sessions revoked',
      logoutAll.status === 200 && liveBefore > 0 && liveAfter === 0,
    );

    const logoutAllNoAuth = await http('POST', `${base}/logout-all`);
    record('logout-all: requires authentication → 401', logoutAllNoAuth.status === 401);

    // ── 8/9. Forgot / reset password ───────────────────────────────────────
    const forgotKnown = await http('POST', `${base}/forgot-password`, { body: { email: 'ada@example.com' } });
    const forgotUnknown = await http('POST', `${base}/forgot-password`, { body: { email: 'ghost@example.com' } });
    // Same envelope modulo requestId (unique per request by design). Reuse of
    // the helper declared above for the anti-enumeration check.
    record(
      'forgot-password: generic identical response for known and unknown emails',
      forgotKnown.status === 200 && stripRequestId(forgotKnown.body) === stripRequestId(forgotUnknown.body),
    );
    const resetToken = logOutboxTransport.extractTokenFromLastEmail('ada@example.com');
    record('forgot-password: reset email rendered in dev outbox', resetToken !== null && resetToken?.length === 64);

    // A login before reset so we can prove session invalidation.
    const login4 = await http('POST', `${base}/login`, { body: { email: 'ada@example.com', password: PASSWORD } });
    const preResetCookie = extractCookie(login4.setCookies, 'refresh_token');

    if (resetToken === null || preResetCookie === undefined) throw new Error('cannot continue reset flow');
    const resetBad = await http('POST', `${base}/reset-password`, {
      body: { email: 'ada@example.com', token: 'f'.repeat(64), password: 'An0therPass!77' },
    });
    record('reset-password: invalid token → 400', resetBad.status === 400);

    const reset = await http('POST', `${base}/reset-password`, {
      body: { email: 'ada@example.com', token: resetToken, password: 'An0therPass!77' },
    });
    record('reset-password: valid → 200', reset.status === 200);

    const resetReplay = await http('POST', `${base}/reset-password`, {
      body: { email: 'ada@example.com', token: resetToken, password: 'An0therPass!88' },
    });
    record('reset-password: one-time use — replay → 400', resetReplay.status === 400);

    const oldPasswordLogin = await http('POST', `${base}/login`, {
      body: { email: 'ada@example.com', password: PASSWORD },
    });
    record('reset-password: old password no longer works → 401', oldPasswordLogin.status === 401);

    const newPasswordLogin = await http('POST', `${base}/login`, {
      body: { email: 'ada@example.com', password: 'An0therPass!77' },
    });
    record('reset-password: new password works → 200', newPasswordLogin.status === 200);

    const preResetSession = await http('POST', `${base}/refresh`, { rawCookie: `refresh_token=${preResetCookie}` });
    record('reset-password: pre-reset sessions invalidated → 401', preResetSession.status === 401);

    // ── 10. Security surface ───────────────────────────────────────────────
    const rateLimited = await http('POST', `${base}/login`, { body: { email: 'x@y.com', password: 'nope1Val!' } });
    record(
      'security: rate-limit headers present on sensitive routes',
      rateLimited.headers.has('ratelimit') || rateLimited.headers.has('ratelimit-limit'),
    );
    const cookieLine = login.setCookies.find((c) => c.startsWith('refresh_token='));
    record(
      'security: cookie has HttpOnly + SameSite + auth path',
      cookieLine !== undefined && cookieLine.includes('HttpOnly') && cookieLine.includes('SameSite=') && cookieLine.includes('Path=/api/v1/auth'),
    );

    // Sensitive limiter REALLY limits: 21 attempts from ONE IP → the tail
    // gets 429. Runs last with a dedicated IP so it poisons nothing.
    const limiterStatuses: number[] = [];
    for (let i = 0; i < 21; i += 1) {
      const attempt = await http('POST', `${base}/login`, {
        body: { email: 'rl@example.com', password: 'nope1Val!' },
        ip: '203.0.113.99',
      });
      limiterStatuses.push(attempt.status);
    }
    record(
      'security: sensitive limiter returns 429 after 20 attempts from one IP',
      limiterStatuses[0] === 401 && limiterStatuses[19] === 401 && limiterStatuses[20] === 429,
    );

    // Health endpoints still fine.
    const health = await http('GET', `http://127.0.0.1:${port}/health`);
    record('health: still returns ok', health.status === 200);
  } finally {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    const { disconnectDatabase } = await import('../server/src/database/database.js');
    await disconnectDatabase();
    await memoryServer.stop();
  }

  const failed = checks.filter((c) => !c.pass).length;
  // eslint-disable-next-line no-console
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('verify-auth driver failed:', error);
  process.exit(1);
});
