import jwt from 'jsonwebtoken';
import { env } from '../config/env.ts';

export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: 'PRODUCT_MANAGER' | 'INTERNAL_TEAM' | 'CLIENT_GUEST';
  department: string | null;
  clientOrgId: string | null;
  typ: 'access';
}

export interface RefreshTokenPayload {
  sub: string;
  /** Correlates a refresh with the row that stores its hash, so we can revoke. */
  jti: string;
  typ: 'refresh';
}

type Signable = AccessTokenPayload | RefreshTokenPayload;

export class TokenError extends Error {
  readonly expired: boolean;
  constructor(message: string, expired = false) {
    super(message);
    this.name = 'TokenError';
    this.expired = expired;
  }
}

function signAccess(payload: Omit<AccessTokenPayload, 'typ'>, expiresIn: string): string {
  return jwt.sign({ ...payload, typ: 'access' } satisfies AccessTokenPayload, env.JWT_ACCESS_SECRET, {
    expiresIn: expiresIn as jwt.SignOptions['expiresIn'],
    issuer: 'nodewave',
    audience: 'nodewave-api',
  });
}

function signRefresh(payload: Omit<RefreshTokenPayload, 'typ'>, expiresIn: string): string {
  return jwt.sign({ ...payload, typ: 'refresh' } satisfies RefreshTokenPayload, env.JWT_REFRESH_SECRET, {
    expiresIn: expiresIn as jwt.SignOptions['expiresIn'],
    issuer: 'nodewave',
    audience: 'nodewave-api',
  });
}

function verify<T extends Signable>(token: string, secret: string, expectedType: T['typ']): T {
  let decoded: string | jwt.JwtPayload;
  try {
    decoded = jwt.verify(token, secret, { issuer: 'nodewave', audience: 'nodewave-api' });
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) throw new TokenError('Token has expired', true);
    throw new TokenError('Token is invalid');
  }

  if (typeof decoded === 'string' || decoded.typ !== expectedType) {
    // A refresh token presented as a bearer token (or vice versa) is a token
    // confusion attempt, not an expiry.
    throw new TokenError('Token type mismatch');
  }

  return decoded as T;
}

export const tokens = {
  signAccess,
  signRefresh,
  verifyAccess: (token: string) => verify<AccessTokenPayload>(token, env.JWT_ACCESS_SECRET, 'access'),
  verifyRefresh: (token: string) => verify<RefreshTokenPayload>(token, env.JWT_REFRESH_SECRET, 'refresh'),

  /** SHA-256, because refresh tokens are high-entropy random values (not passwords). */
  hashRefreshToken: (token: string) => new Bun.CryptoHasher('sha256').update(token).digest('hex'),

  refreshTtlMs: (ttl: string) => {
    const match = /^(\d+)([smhd])$/.exec(ttl);
    if (!match) return 7 * 24 * 60 * 60 * 1000;
    const value = Number(match[1]);
    const unit = match[2] as 's' | 'm' | 'h' | 'd';
    const factor = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
    return value * factor;
  },
};
