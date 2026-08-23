import { createHash, randomBytes } from 'node:crypto';

export const generateInviteCode = (): string => {
  const raw = randomBytes(9).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const padded = (raw + 'AAAAAAAAAAAAAAAA').slice(0, 12);
  const a = padded.slice(0, 4);
  const b = padded.slice(4, 8);
  const c = padded.slice(8, 12);
  return `LEY-${a}-${b}-${c}`.slice(0, 16);
};

export const normalizeInviteCode = (code: string): string => {
  return code.trim().toUpperCase().replace(/\s+/g, '');
};

export const hashInviteCode = (code: string): string => {
  return createHash('sha256').update(normalizeInviteCode(code)).digest('hex');
};
