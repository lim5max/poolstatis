import { createPool } from '../db.js';
import { applyMigration023Cleanup, inspectMigration023 } from '../services/migration023Preflight.js';

if (process.argv.includes('--help')) {
  console.log(`Usage:
  node dist/cli/preflightMigration023.js --report
  node dist/cli/preflightMigration023.js --apply --ack <digest> --backup <reference>`);
} else {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'preflight failed');
    process.exitCode = 1;
  });
}

async function main(): Promise<void> {
  const pool = createPool(process.env.DATABASE_URL ?? 'postgres://poolsatis:poolsatis@localhost:5444/poolsatis');
  try {
    const report = await inspectMigration023(pool);
    if (process.argv.includes('--apply')) {
      const ack = argument('--ack');
      const backup = argument('--backup');
      if (!ack || !backup) throw new Error('--apply requires --ack <digest> and --backup <reference>');
      const applied = await applyMigration023Cleanup(pool, {
        acknowledgement: ack,
        backupAttestation: backup,
      });
      console.log(JSON.stringify({
        protocol: 'migration-023/v2',
        status: 'constraints_installed',
        backup_attestation: backup,
        ...applied,
      }));
    } else {
      console.log(JSON.stringify({ status: 'report_only', ...report }));
    }
  } finally {
    await pool.end();
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
