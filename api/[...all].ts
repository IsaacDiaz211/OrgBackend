import { app } from '../src/app';

// Catch-all Vercel function so /api/v1/* routes are resolved by Elysia.
export default {
  fetch: app.fetch,
};
