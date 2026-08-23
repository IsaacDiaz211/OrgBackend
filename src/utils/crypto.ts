import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const sha256 = (value: string): string => {
  return createHash('sha256').update(value).digest('hex');
};

export const hashInstallId = (installId: string): string => {
  return sha256(installId.trim());
};

export const createNonce = (size = 32): string => {
  return randomBytes(size).toString('base64url');
};

export const safeStringEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
};
