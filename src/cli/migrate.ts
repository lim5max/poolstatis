import { createPool, migrate } from '../db.js';
import { loadConfig } from '../config.js';

if (process.argv.includes('--help')) {
  console.log('Usage: node dist/cli/migrate.js');
} else {
  const pool = createPool(loadConfig().databaseUrl);
  try {
    const applied = await migrate(pool);
    console.log(applied.length ? `applied: ${applied.join(', ')}` : 'schema up to date');
  } finally {
    await pool.end();
  }
}
