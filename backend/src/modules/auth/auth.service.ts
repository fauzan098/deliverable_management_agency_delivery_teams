import { env } from '../../config/env.ts';
import type { Actor } from '../../core/authz/types.ts';
import { AppError } from '../../lib/errors.ts';
import { tokens } from '../../lib/jwt.ts';
import { hashPassword, verifyPassword } from '../../lib/password.ts';
import { prisma } from '../../lib/prisma.ts';
import { type PublicUser, toPublicUser } from '../tasks/dto.ts';

export interface AuthSession {
  user: PublicUser & { clientOrgId: string | null };
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires, for the client to schedule a refresh. */
  expiresIn: number;
}

/**
 * Self-registration is restricted to INTERNAL_TEAM on purpose.
 *
 * A CLIENT_GUEST is a tenant-scoped identity bound to a client organisation. If
 * anyone could self-assign that role, the multi-tenant boundary the brief
 * demands would be one POST away from being meaningless. Client accounts are
 * therefore provisioned by a Product Manager via `POST /api/projects/:id/members`.
 */
const SELF_REGISTERABLE_ROLES = ['INTERNAL_TEAM'] as const;

export interface RegisterInput {
  email: string;
  password: string;
  name: string;
  department: 'UI_UX' | 'FRONTEND' | 'BACKEND' | 'PRODUCT';
}

export async function register(input: RegisterInput): Promise<AuthSession> {
  const email = input.email.toLowerCase().trim();

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true, deletedAt: true } });
  if (existing && !existing.deletedAt) {
    throw new AppError('EMAIL_ALREADY_REGISTERED', 'An account with this email already exists', { email });
  }

  const passwordHash = await hashPassword(input.password);

  // A PRODUCT_MANAGER can be created this way, but the account is not a member
  // of any project yet; membership is granted explicitly by an existing PM.
  const role = input.department === 'PRODUCT' ? 'PRODUCT_MANAGER' : 'INTERNAL_TEAM';

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      name: input.name,
      role,
      department: input.department,
      isActive: true,
    },
  });

  return issueSession(user);
}

export async function login(args: {
  email: string;
  password: string;
  meta?: { userAgent?: string; ip?: string };
}): Promise<AuthSession> {
  const email = args.email.toLowerCase().trim();

  const user = await prisma.user.findUnique({ where: { email } });

  /**
   * Always run a verification, even when the user does not exist, so response
   * time does not reveal which emails are registered.
   */
  const passwordOk = await verifyPassword(args.password, user?.passwordHash ?? '$argon2id$v=19$m=19456,t=2,p=1$');

  if (!user || !passwordOk) {
    throw new AppError('INVALID_CREDENTIALS', 'Email or password is incorrect');
  }
  if (!user.isActive) {
    throw new AppError('FORBIDDEN', 'This account has been deactivated');
  }

  return issueSession(user, args.meta);
}

export async function issueSession(
  user: {
    id: string;
    email: string;
    name: string;
    avatarUrl: string | null;
    role: any;
    department: any;
    clientOrgId: string | null;
  },
  meta?: { userAgent?: string; ip?: string },
): Promise<AuthSession> {
  const accessToken = tokens.signAccess(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
      department: user.department,
      clientOrgId: user.clientOrgId,
    },
    env.JWT_ACCESS_TTL,
  );

  // The refresh token is a JWT whose `jti` *is* the id of the row that stores
  // its hash. Minting the id first means one write, and makes the later
  // `stored.id === payload.jti` check a property of the design rather than a
  // coincidence: a token cannot claim a session row that is not its own.
  const jti = crypto.randomUUID();
  const refreshToken = tokens.signRefresh({ sub: user.id, jti }, env.JWT_REFRESH_TTL);

  await prisma.refreshToken.create({
    data: {
      id: jti,
      userId: user.id,
      tokenHash: tokens.hashRefreshToken(refreshToken),
      expiresAt: new Date(Date.now() + tokens.refreshTtlMs(env.JWT_REFRESH_TTL)),
      ...(meta?.userAgent ? { userAgent: meta.userAgent } : {}),
      ...(meta?.ip ? { ipAddress: meta.ip } : {}),
    },
  });

  return {
    user: { ...toPublicUser(user as any), clientOrgId: user.clientOrgId },
    accessToken,
    refreshToken,
    expiresIn: Math.floor(tokens.refreshTtlMs(env.JWT_ACCESS_TTL) / 1000),
  };
}

/**
 * Rotate a refresh token.
 *
 * The presented token is revoked and a fresh one issued, so a token that is
 * replayed after rotation is detectable (its row is already revoked) and can no
 * longer be used to mint access tokens.
 */
export async function refresh(
  presentedToken: string,
  meta?: { userAgent?: string; ip?: string },
): Promise<AuthSession> {
  const payload = (() => {
    try {
      return tokens.verifyRefresh(presentedToken);
    } catch {
      throw new AppError('TOKEN_EXPIRED', 'Session expired, please sign in again');
    }
  })();

  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash: tokens.hashRefreshToken(presentedToken) },
    include: { user: true },
  });

  if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
    throw new AppError('TOKEN_EXPIRED', 'Session expired, please sign in again');
  }

  if (stored.id !== payload.jti || stored.userId !== payload.sub) {
    throw new AppError('UNAUTHORIZED', 'Invalid session');
  }

  if (!stored.user.isActive) {
    throw new AppError('FORBIDDEN', 'This account has been deactivated');
  }

  await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });

  return issueSession(stored.user, meta);
}

/**
 * Logout revokes the presented refresh token. Revocation rather than deletion
 * keeps the row as evidence that a session existed and when it ended.
 */
export async function logout(refreshToken: string | undefined): Promise<void> {
  if (!refreshToken) return;
  await prisma.refreshToken.updateMany({
    where: { tokenHash: tokens.hashRefreshToken(refreshToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Resolve the JWT claims into a full `Actor`.
 *
 * One database read per request. It is not cached in the token because the
 * claims that matter to authorisation — tenant organisation and project
 * membership — change independently of the token's lifetime, and a stale cache
 * here would be a stale *permission*.
 */
export async function resolveActor(claims: {
  sub: string;
  email: string;
  role: 'PRODUCT_MANAGER' | 'INTERNAL_TEAM' | 'CLIENT_GUEST';
  department: string | null;
  clientOrgId: string | null;
}): Promise<Actor> {
  const user = await prisma.user.findUnique({
    where: { id: claims.sub },
    select: {
      id: true,
      email: true,
      name: true,
      avatarUrl: true,
      role: true,
      department: true,
      clientOrgId: true,
      isActive: true,
      projectMembers: { where: { deletedAt: null }, select: { projectId: true } },
    },
  });

  if (!user || !user.isActive) {
    throw new AppError('UNAUTHORIZED', 'Account is no longer active');
  }

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    role: user.role,
    department: user.department,
    clientOrgId: user.clientOrgId,
    projectIds: user.projectMembers.map((m) => m.projectId),
  };
}

export async function getMe(
  actor: Actor,
): Promise<PublicUser & { clientOrgId: string | null; accessibleProjects: number }> {
  const accessibleProjects =
    actor.role === 'PRODUCT_MANAGER'
      ? await prisma.project.count()
      : actor.role === 'INTERNAL_TEAM'
        ? actor.projectIds.length
        : await prisma.project.count({ where: { clientOrgId: actor.clientOrgId ?? '__none__' } });

  return {
    id: actor.id,
    name: actor.name,
    email: actor.email,
    avatarUrl: actor.avatarUrl,
    role: actor.role,
    department: actor.department,
    clientOrgId: actor.clientOrgId,
    accessibleProjects,
  };
}

export { SELF_REGISTERABLE_ROLES };
