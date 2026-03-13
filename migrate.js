import 'dotenv/config';
import { readFileSync } from 'fs';
import postgres from 'postgres';

const url = process.env.SESSION_POOL_URL;
if (!url) {
  console.error('ERROR: SESSION_POOL_URL is not set. Copy .env.example to .env and fill in your URLs.');
  process.exit(1);
}

const sql = postgres(url, { max: 1 });
const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

try {
  await sql.unsafe(schema);
  console.log('Migration complete: credits table ready.');
} finally {
  await sql.end();
}
