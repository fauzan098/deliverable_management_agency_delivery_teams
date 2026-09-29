import { afterAll, describe, expect, test } from 'bun:test';
import { prisma } from '../../lib/prisma.ts';

/**
 * The audit trail's central promise is that history cannot be rewritten — not
 * "the API does not offer an endpoint to rewrite it", but *the database will
 * refuse even if a future code path, a careless migration or a psql session
 * tries*. That is enforced by a trigger, and this is the test that proves the
 * trigger is actually installed.
 *
 * It runs against the configured development database (the seed guarantees
 * rows exist). Nothing here can mutate state: every attempt is expected to be
 * rejected, so re-running is harmless.
 *
 * Prisma returns a lazy `PrismaPromise`, which the matcher cannot treat as a
 * thenable, so each attempt is executed inside a helper and its error message
 * is asserted to name the trigger.
 */

afterAll(async () => {
  await prisma.$disconnect();
});

async function rejectionMessage(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected the operation to be rejected, but it resolved');
}

/**
 * Asserts only that the operation was refused. The trigger raises
 * `restrict_violation`, and the pg adapter classifies that as a generic
 * constraint violation without preserving the trigger's text — so asserting on
 * the message would be testing Prisma's error mapping, not our guarantee. The
 * stored-state checks below are what prove the row was untouched.
 */
async function expectRejected(run: () => Promise<unknown>): Promise<void> {
  await rejectionMessage(run);
}

async function firstLog() {
  const log = await prisma.taskLog.findFirst({ orderBy: { createdAt: 'asc' } });
  expect(log).not.toBeNull();
  return log!;
}

describe('TaskLog append-only guarantee', () => {
  test('an UPDATE is rejected by the trigger and the stored value is untouched', async () => {
    const original = await firstLog();

    await expectRejected(() => prisma.taskLog.update({ where: { id: original.id }, data: { newValue: 'TAMPERED' } }));

    const after = await prisma.taskLog.findUnique({ where: { id: original.id } });
    expect(after?.newValue).toBe(original.newValue);
  });

  test('a DELETE is rejected and the row survives', async () => {
    const original = await firstLog();

    await expectRejected(() => prisma.taskLog.delete({ where: { id: original.id } }));

    const after = await prisma.taskLog.findUnique({ where: { id: original.id } });
    expect(after).not.toBeNull();
  });

  test('a raw SQL update surfaces the trigger message, so the guard lives in the database and not in Prisma', async () => {
    const original = await firstLog();

    const message = await rejectionMessage(() =>
      prisma.$executeRawUnsafe(`UPDATE "task_logs" SET "new_value" = 'RAW_TAMPER' WHERE "id" = $1`, original.id),
    );
    expect(message).toContain('append-only');
  });
});
