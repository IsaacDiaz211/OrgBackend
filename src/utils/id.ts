export const createId = (): string => {
  if (typeof Bun !== 'undefined' && typeof Bun.randomUUIDv7 === 'function') {
    return Bun.randomUUIDv7();
  }

  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
};
