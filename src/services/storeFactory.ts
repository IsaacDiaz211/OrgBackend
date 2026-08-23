import type { AppConfig } from '../config';
import type { KeyBrokerStore } from './store';
import { MemoryKeyBrokerStore } from './store';
import { RedisKeyBrokerStore } from './redisStore';
import { SqliteKeyBrokerStore } from './sqliteStore';
import { UpstashKeyBrokerStore } from './upstashStore';

export const createStore = (cfg: AppConfig): KeyBrokerStore => {
  const upstashUrl = cfg.storage.upstashUrl.trim();
  const upstashToken = cfg.storage.upstashToken.trim();
  const redisUrl = cfg.storage.redisUrl.trim();
  const databaseUrl = cfg.storage.databaseUrl.trim();

  if (upstashUrl && upstashToken) {
    console.log('[key-leasing] using Upstash Redis store');
    return new UpstashKeyBrokerStore(upstashUrl, upstashToken);
  }

  if (redisUrl) {
    console.log('[key-leasing] using Redis/Valkey store');
    return new RedisKeyBrokerStore(redisUrl);
  }

  if (databaseUrl.startsWith('sqlite:')) {
    console.log('[key-leasing] using Sqlite store');
    return new SqliteKeyBrokerStore(databaseUrl);
  }

  console.warn('[key-leasing] using in-memory store (not recommended for production)');
  return new MemoryKeyBrokerStore();
};
