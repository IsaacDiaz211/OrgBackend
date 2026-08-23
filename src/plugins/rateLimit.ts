import { brokerStore } from '../container';
import { HttpError } from '../utils/errors';

export const applyRateLimit = async (bucketKey: string, maxPerMinute: number): Promise<void> => {
  const decision = await brokerStore.checkRateLimit(bucketKey, maxPerMinute, 60);
  if (!decision.allowed) {
    throw new HttpError(429, 'Rate limit exceeded', {
      resetAt: new Date(decision.resetAt).toISOString(),
    });
  }
};
