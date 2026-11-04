import { config as loadEnv } from '../../../tests/load-env.js';
import { loadConfig } from '../../../platform/config/src/index.js';
import { createPool } from '../../../platform/db/src/index.js';
import { createApp } from './app.js';

loadEnv();

async function main() {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL);
  const app = createApp(pool, config);
  app.listen(config.PORT, () => {
    console.info(`DayPI API listening on :${config.PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
