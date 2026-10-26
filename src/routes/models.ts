import { Elysia } from 'elysia';
import { MODEL_FALLBACKS, config } from '../config';

// T5-backend: GET /api/v1/models — public (no auth; model names are not secrets).
//
// Contract — IDENTICAL in EdgeBackend and OrgBackend (keep in sync):
// {
//   "primaryChain": [string, string, string], // translation fallback chain
//   "segmentationChain": [string],            // segmentation model
//   "assistModel": string,                    // grammar-assist model
//   "defaults": { primaryChain, segmentationChain, assistModel } // hardcoded fallbacks
// }
// Top-level fields resolve server env (OPENROUTER_MODEL, _2, _3, _SEG, _ASSIST);
// `defaults` always holds the hardcoded fallbacks so clients can detect overrides.
// Fallbacks match ravenToPandas/services/OpenRouterTranslation.ts:84-87 and
// ravenToPandas/services/OpenRouterGrammarAssist.ts:28-31.
export function getModelsResponse() {
  const primaryChain = [config.models.primary, config.models.primary2, config.models.primary3];
  const segmentationChain = [config.models.segmentation];
  return {
    primaryChain,
    segmentationChain,
    assistModel: config.models.assist,
    defaults: {
      primaryChain: [MODEL_FALLBACKS.primary, MODEL_FALLBACKS.primary, MODEL_FALLBACKS.primary],
      segmentationChain: [MODEL_FALLBACKS.segmentation],
      assistModel: MODEL_FALLBACKS.assist,
    },
  };
}

export type ModelsResponse = ReturnType<typeof getModelsResponse>;

export const modelsRoutes = new Elysia().get('/models', () => getModelsResponse());
