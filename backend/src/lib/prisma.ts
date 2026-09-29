/* eslint-disable @typescript-eslint/no-explicit-any */
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '../config/env.ts';
import { Prisma, PrismaClient } from '../generated/prisma/client.ts';

/**
 * Prisma 7 requires a driver adapter; the connection string no longer lives in
 * the schema. Bun runs the `pg` driver through its Node compatibility layer.
 */
const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

/**
 * Models that participate in soft delete.
 *
 * Three models are deliberately excluded:
 *
 * - `TaskLog` is append-only and has no `deletedAt`; it is the record of what
 *   happened, and removing a row from it is precisely the tampering the
 *   database trigger forbids.
 * - `TaskDependency` has no `deletedAt` either; removing a dependency is a real
 *   delete, and is itself recorded in the audit trail.
 * - `ClientOrganization` has no `deletedAt` column and no delete flow; adding it
 *   here would make every read emit a filter on a nonexistent column.
 */
const SOFT_DELETE_MODELS = new Set(['User', 'Project', 'ProjectMember', 'Task', 'Attachment', 'Comment']);

type PrismaDelegate = {
  withDeleted<T>(fn: (tx: any) => Promise<T>): Promise<T>;
};

export type SoftDeleteClient = PrismaClient & PrismaDelegate;

/**
 * Default-scope soft delete.
 *
 * Every read is transparently filtered to `deletedAt: null`, and every
 * `update`/`delete` refuses to target a soft-deleted row. This makes "no entity
 * is ever truly deleted" a property of the data-access layer rather than a rule
 * each service has to remember.
 *
 * The internals are intentionally loosely typed: Prisma types the `$allModels`
 * callback's `args` as a union across every model, which no amount of
 * narrowing can narrow safely. The public surface stays fully typed because
 * `withSoftDelete` is annotated to return `SoftDeleteClient`, and the runtime
 * behaviour is covered by `test/soft-delete.test.ts`.
 *
 * `withDeleted()` is the escape hatch for administrative restores and for the
 * seed script's idempotent re-run.
 */
function withSoftDelete(client: PrismaClient): SoftDeleteClient {
  const extendWithGuards = (c: PrismaClient) =>
    c.$extends({
      name: 'soft-delete',
      query: {
        $allModels: {
          async findMany({ model, args, query }: any) {
            if (!SOFT_DELETE_MODELS.has(model)) return query(args);
            return query({ ...args, where: { AND: [args?.where ?? {}, { deletedAt: null }] } });
          },
          async findFirst({ model, args, query }: any) {
            if (!SOFT_DELETE_MODELS.has(model)) return query(args);
            return query({ ...args, where: { AND: [args?.where ?? {}, { deletedAt: null }] } });
          },
          async findFirstOrThrow({ model, args, query }: any) {
            if (!SOFT_DELETE_MODELS.has(model)) return query(args);
            return query({ ...args, where: { AND: [args?.where ?? {}, { deletedAt: null }] } });
          },
          async findUnique({ model, args, query }: any) {
            if (!SOFT_DELETE_MODELS.has(model)) return query(args);
            // Prisma's unique operations require a *unique* selector and reject
            // an `AND` wrapper, so the guard is spread in beside the key. This
            // is Prisma's "extendedWhereUnique" behaviour and keeps the lookup
            // a single indexed query.
            return query({ ...args, where: { ...args.where, deletedAt: null } });
          },
          async findUniqueOrThrow({ model, args, query }: any) {
            if (!SOFT_DELETE_MODELS.has(model)) return query(args);
            return query({ ...args, where: { ...args.where, deletedAt: null } });
          },
          async count({ model, args, query }: any) {
            if (!SOFT_DELETE_MODELS.has(model)) return query(args);
            return query({ ...args, where: { AND: [args?.where ?? {}, { deletedAt: null }] } });
          },
          async aggregate({ model, args, query }: any) {
            if (!SOFT_DELETE_MODELS.has(model)) return query(args);
            return query({ ...args, where: { AND: [args?.where ?? {}, { deletedAt: null }] } });
          },
          async groupBy({ model, args, query }: any) {
            if (!SOFT_DELETE_MODELS.has(model)) return query(args);
            return query({ ...args, where: { AND: [args?.where ?? {}, { deletedAt: null }] } });
          },
          async update({ model, args, query }: any) {
            if (!SOFT_DELETE_MODELS.has(model)) return query(args);
            // `update` also takes a unique selector, so the guard is spread.
            return query({ ...args, where: { ...args.where, deletedAt: null } });
          },
          async updateMany({ model, args, query }: any) {
            if (!SOFT_DELETE_MODELS.has(model)) return query(args);
            return query({ ...args, where: { AND: [args.where, { deletedAt: null }] } });
          },
          async delete({ model, args, query }: any) {
            if (!SOFT_DELETE_MODELS.has(model)) return query(args);
            return query({ ...args, where: { ...args.where, deletedAt: null } });
          },
          async deleteMany({ model, args, query }: any) {
            if (!SOFT_DELETE_MODELS.has(model)) return query(args);
            return query({ ...args, where: { AND: [args?.where ?? {}, { deletedAt: null }] } });
          },
        },
      },
    }) as unknown as SoftDeleteClient;

  const guarded = extendWithGuards(client);

  Object.defineProperty(guarded, 'withDeleted', {
    value: <T>(fn: (tx: SoftDeleteClient) => Promise<T>): Promise<T> => fn(extendWithGuards(client)),
    enumerable: false,
  });

  return guarded;
}

const globalForPrisma = globalThis as unknown as { prisma?: SoftDeleteClient };

/**
 * Reuse the client across Bun's hot reloads so `bun --watch` does not leak
 * connection pools on every file change.
 */
export const prisma: SoftDeleteClient = globalForPrisma.prisma ?? withSoftDelete(new PrismaClient({ adapter }));

if (!env.isProduction) globalForPrisma.prisma = prisma;

export { withSoftDelete, PrismaClient, Prisma };
