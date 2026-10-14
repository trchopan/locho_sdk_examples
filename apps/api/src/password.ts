import argon2 from 'argon2';

export const passwordOptions = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, passwordOptions);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password);
}
