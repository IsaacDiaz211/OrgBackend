import { app } from './app';
import { config } from './config';

app.listen(config.port);

const baseUrl = app.server?.url.toString().replace(/\/$/, '') ?? `http://localhost:${config.port}`;
console.log(`[key-leasing] listening at ${baseUrl}${config.apiPrefix}`);
