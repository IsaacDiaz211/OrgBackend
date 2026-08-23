import { config } from './config';
import { createStore } from './services/storeFactory';
import { OpenRouterManagementClient } from './services/openrouter';

export const brokerStore = createStore(config);

export const openRouterClient = new OpenRouterManagementClient({
  baseUrl: config.openRouter.managementBaseUrl,
  managementKey: config.openRouter.managementKey,
  requestTimeoutMs: config.openRouter.requestTimeoutMs,
});
