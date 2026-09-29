import { afterAll, describe, expect, test } from 'bun:test';
import { AppError, type ErrorCode } from '../../lib/errors.ts';
import { tokens } from '../../lib/jwt.ts';
import { prisma } from '../../lib/prisma.ts';
import { logout, refresh } from './auth.service.ts';

/**
 * Session rotation is the one place where a silent break is invisible until
 * users are mysteriously logged out: nothing in the happy path looks wrong, a
 * page reload just quietly lands on /login. These tests pin the whole rotation
 * contract against the real database.
 *
 * Each test mints its own session and revokes it again, so re-running leaves no
 * live sessions behind.
 */

afterAll(async () => {
  await prisma.$disconnect();
});

async function seededUser() {
  const user = await prisma.user.findFirst({ where: { email: 'pm@nodewave.dev' } });
  if (!user) throw new Error('seed first: `bun run db:seed`');
  return user;
}

async function mintSession() {
  const { issueSession } = await import('./auth.service.ts');
  return issueSession(await seededUser());
}

async function expectAppError(run: () => Promise<unknown>, code: ErrorCode): Promise<void> {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, but the call resolved`);
}

describe('refresh token rotation', () => {
  test('the issued refresh token is a JWT whose jti is the stored session row', async () => {
    const session = await mintSession();

    const payload = tokens.verifyRefresh(session.refreshToken);
    const stored = await prisma.refreshToken.findUnique({
      where: { tokenHash: tokens.hashRefreshToken(session.refreshToken) },
    });

    expect(payload.typ).toBe('refresh');
    expect(stored).not.toBeNull();
    expect(stored?.id).toBe(payload.jti);
    expect(stored?.userId).toBe(payload.sub);
    expect(stored?.revokedAt).toBeNull();

    await logout(session.refreshToken);
  });

  test('refreshing issues a new pair and revokes the presented one', async () => {
    const first = await mintSession();
    const second = await refresh(first.refreshToken);

    // Access tokens are not expected to differ: `iat`/`exp` have one-second
    // resolution, so a refresh within the same second re-signs an identical
    // payload. The refresh token is what must rotate.
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(tokens.verifyAccess(second.accessToken).sub).toBe(tokens.verifyAccess(first.accessToken).sub);

    const oldRow = await prisma.refreshToken.findUnique({
      where: { tokenHash: tokens.hashRefreshToken(first.refreshToken) },
    });
    const newRow = await prisma.refreshToken.findUnique({
      where: { tokenHash: tokens.hashRefreshToken(second.refreshToken) },
    });
    expect(oldRow?.revokedAt).not.toBeNull();
    expect(newRow?.revokedAt).toBeNull();

    await logout(second.refreshToken);
  });

  test('a rotated-out token cannot be replayed', async () => {
    const first = await mintSession();
    const second = await refresh(first.refreshToken);

    await expectAppError(() => refresh(first.refreshToken), 'TOKEN_EXPIRED');

    await logout(second.refreshToken);
  });

  test('logout revokes the session', async () => {
    const session = await mintSession();
    await logout(session.refreshToken);

    await expectAppError(() => refresh(session.refreshToken), 'TOKEN_EXPIRED');
  });

  test('an access token is not accepted as a refresh token', async () => {
    const session = await mintSession();

    // Token confusion: the access token is a valid JWT, signed with a different
    // secret, so verification fails outright rather than matching a session.
    await expectAppError(() => refresh(session.accessToken), 'TOKEN_EXPIRED');

    await logout(session.refreshToken);
  });

  test('garbage is rejected', async () => {
    await expectAppError(() => refresh('not-a-token'), 'TOKEN_EXPIRED');
  });
});
