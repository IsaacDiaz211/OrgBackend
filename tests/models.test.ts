import { describe, test, expect } from 'bun:test';
import { app } from '../src/app';
import { getModelsResponse } from '../src/routes/models';

const MODELS_URL = 'http://localhost/api/v1/models';

describe('T5 — GET /api/v1/models (public, identical contract)', () => {
  test('returns 200 without auth and the documented shape', async () => {
    const res = await app.handle(new Request(MODELS_URL));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReturnType<typeof getModelsResponse>;
    expect(Object.keys(body).sort()).toEqual(
      ['assistModel', 'defaults', 'primaryChain', 'segmentationChain'].sort(),
    );
    expect(body.primaryChain).toHaveLength(3);
    expect(body.segmentationChain).toHaveLength(1);
    for (const name of [...body.primaryChain, ...body.segmentationChain, body.assistModel]) {
      expect(typeof name).toBe('string');
      expect(name.trim().length).toBeGreaterThan(0);
    }
    expect(Object.keys(body.defaults).sort()).toEqual(
      ['assistModel', 'primaryChain', 'segmentationChain'].sort(),
    );
  });

  test('defaults match the hardcoded app fallbacks', async () => {
    const res = await app.handle(new Request(MODELS_URL));
    const body = (await res.json()) as ReturnType<typeof getModelsResponse>;
    expect(body.defaults).toEqual({
      primaryChain: ['inception/mercury-2.5', 'inception/mercury-2.5', 'inception/mercury-2.5'],
      segmentationChain: ['inclusionai/ling-3.0-flash-fin'],
      assistModel: 'inception/mercury-2',
    });
  });
});
