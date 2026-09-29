/**
 * Password hashing via Bun's native Argon2id. No third-party dependency, and the
 * algorithm parameters are strong by default (memory-hard, which is what you
 * want against GPU cracking).
 */

const OPTIONS = {
  algorithm: 'argon2id',
  memoryCost: 19_456, // KiB
  timeCost: 2,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return Bun.password.hash(plain, OPTIONS);
}

/**
 * Argon2 hashes are self-describing, so verification is a single constant-time
 * compare inside Bun. A stored value that is not a valid hash simply fails
 * rather than throwing.
 */
export async function verifyPassword(plain: string, storedHash: string): Promise<boolean> {
  if (!storedHash) return false;
  try {
    return await Bun.password.verify(plain, storedHash);
  } catch {
    return false;
  }
}
