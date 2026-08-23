import { Elysia } from 'elysia';
import { config } from './config';
import { HttpError } from './utils/errors';
import { healthRoutes } from './routes/health';
import { challengeRoutes } from './routes/challenge';
import { sessionRoutes } from './routes/session';
import { openrouterRoutes } from './routes/openrouter';
import { cronRoutes } from './routes/cron';
import { organizationRoutes } from './routes/organization';
import { adminRoutes } from './routes/admin';

export const app = new Elysia()
  .onError(({ code, error, set }) => {
    if (error instanceof HttpError) {
      set.status = error.status;
      return {
        error: error.message,
        details: error.details,
      };
    }

    if (code === 'VALIDATION') {
      set.status = 422;
      return {
        error: 'Invalid request payload',
        details: error.message,
      };
    }

    set.status = 500;
    return {
      error: 'Internal server error',
    };
  })
  .group(config.apiPrefix, (api) =>
    api
      .use(healthRoutes)
      .use(challengeRoutes)
      .use(sessionRoutes)
      .use(openrouterRoutes)
      .use(organizationRoutes)
      .use(adminRoutes)
      .use(cronRoutes)
  );
