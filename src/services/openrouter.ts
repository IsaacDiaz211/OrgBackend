import { sha256 } from '../utils/crypto';
import { HttpError } from '../utils/errors';
import type { LimitReset } from '../types';

// Thin client for OpenRouter Management API key lifecycle endpoints.
// Docs: https://openrouter.ai/docs/guides/overview/auth/management-api-keys
type CreateKeyInput = {
  name: string;
  limit: number;
  limitReset: LimitReset;
  includeByokInLimit: boolean;
  extraPayload?: Record<string, unknown>;
};

export type ManagedKey = {
  key: string;
  hash: string;
  label?: string;
  name?: string;
};

type OpenRouterClientConfig = {
  baseUrl: string;
  managementKey: string;
  requestTimeoutMs: number;
};

type AnyObject = Record<string, unknown>;

const asObject = (value: unknown): AnyObject | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as AnyObject;
};

const asString = (value: unknown): string | undefined => {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

const readStringByKeys = (target: AnyObject | null, keys: string[]): string | undefined => {
  if (!target) {
    return undefined;
  }

  for (const key of keys) {
    const value = asString(target[key]);
    if (value) {
      return value;
    }
  }

  return undefined;
};

const firstDataEntry = (root: AnyObject): AnyObject | null => {
  const data = root.data;
  if (Array.isArray(data)) {
    const first = data[0];
    return asObject(first);
  }

  return asObject(data);
};

export class OpenRouterManagementClient {
  constructor(private readonly config: OpenRouterClientConfig) {}

  isConfigured(): boolean {
    return this.config.managementKey.trim().length > 0;
  }

  private async request(path: string, init: RequestInit): Promise<AnyObject> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.config.managementKey}`,
          'content-type': 'application/json',
          ...(init.headers ?? {}),
        },
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new HttpError(504, 'OpenRouter Management API request timed out', {
          path,
          timeoutMs: this.config.requestTimeoutMs,
        });
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }

    const rawText = await response.text();
    const parsed = rawText ? (JSON.parse(rawText) as unknown) : {};
    const payload = asObject(parsed) ?? {};

    if (!response.ok) {
      throw new HttpError(502, 'OpenRouter Management API request failed', {
        status: response.status,
        path,
        payload,
      });
    }

    return payload;
  }

  async createKey(input: CreateKeyInput): Promise<ManagedKey> {
    const body: AnyObject = {
      name: input.name,
      limit: input.limit,
      include_byok_in_limit: input.includeByokInLimit,
    };

    if (input.limitReset) {
      body.limit_reset = input.limitReset;
    }

    if (input.extraPayload) {
      Object.assign(body, input.extraPayload);
    }

    const payload = await this.request('/keys', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    const dataEntry = firstDataEntry(payload);
    const rootKey = readStringByKeys(payload, ['key', 'api_key']);
    const entryKey = readStringByKeys(dataEntry, ['key', 'api_key']);
    const key = entryKey ?? rootKey;

    if (!key) {
      throw new HttpError(502, 'OpenRouter response did not include key value', payload);
    }

    return {
      key,
      hash: readStringByKeys(dataEntry, ['hash', 'key_hash']) ?? sha256(key),
      label: readStringByKeys(dataEntry, ['label']),
      name: readStringByKeys(dataEntry, ['name']),
    };
  }

  async deleteKey(hash: string): Promise<void> {
    await this.request(`/keys/${encodeURIComponent(hash)}`, {
      method: 'DELETE',
    });
  }
}
