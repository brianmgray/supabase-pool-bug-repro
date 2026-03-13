import 'dotenv/config';
import postgres from 'postgres';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const pool = process.env.POOL ?? 'transaction';
const url = pool === 'session'
  ? process.env.SESSION_POOL_URL
  : process.env.TRANSACTION_POOL_URL;

if (!url) {
  console.error(`ERROR: ${pool === 'session' ? 'SESSION_POOL_URL' : 'TRANSACTION_POOL_URL'} is not set.`);
  console.error('Copy .env.example to .env and fill in your Supabase connection URLs.');
  process.exit(1);
}

const label = pool === 'session'
  ? '--- Session Pooler (port 5432) ---'
  : '--- Transaction Pooler (port 6543) ---';

// Top-level connection used for setup and post-commit verification.
// Must be separate from the transaction connections so verification
// queries run on a clean connection after COMMIT.
const sql = postgres(url, { max: 10 });

class InsufficientFundsError extends Error {
  constructor(balance, required) {
    super(`Insufficient funds: balance=${balance}, required=${required}`);
    this.balance = balance;
    this.required = required;
  }
}

// ---------------------------------------------------------------------------
// Phase 1: Demonstrate why READ COMMITTED is insufficient (overdraft problem)
// ---------------------------------------------------------------------------

async function runPhase1() {
  console.log('\n=== Phase 1: READ COMMITTED allows overdraft ===\n');

  const customerId = `cust-rc-${randomUUID()}`;

  // Seed: grant 100 credits
  await sql`
    INSERT INTO credits (customer_id, amount, type, idempotency_key)
    VALUES (${customerId}, 100, 'GRANT', ${`grant-rc-${randomUUID()}`})
  `;

  const HOLD_AMOUNT = 60;
  const CONCURRENCY = 4;

  // 4 concurrent READ COMMITTED transactions each try to hold 60 credits.
  // With a balance of 100, only 1 should succeed — but READ COMMITTED lets
  // multiple transactions see the same balance and all commit, causing overdraft.
  const results = await Promise.allSettled(
    Array.from({ length: CONCURRENCY }, (_, i) =>
      sql.begin(async tx => {
        const [{ balance }] = await tx`
          SELECT COALESCE(SUM(amount), 0)::int AS balance
          FROM credits WHERE customer_id = ${customerId}
        `;
        if (balance < HOLD_AMOUNT) throw new InsufficientFundsError(balance, HOLD_AMOUNT);
        await tx`
          INSERT INTO credits (customer_id, amount, type, idempotency_key)
          VALUES (${customerId}, ${-HOLD_AMOUNT}, 'HELD', ${`hold-rc-${i}-${randomUUID()}`})
        `;
        return balance;
      })
    )
  );

  const successes = results.filter(r => r.status === 'fulfilled').length;

  if (successes > 1) {
    console.log(`  ⚠️  READ COMMITTED allows overdraft: ${successes} holds succeeded on balance of 100`);
    console.log(`     (${successes} x ${HOLD_AMOUNT} = ${successes * HOLD_AMOUNT} credits held, but only 100 available)`);
  } else {
    console.log(`  ℹ️  Only ${successes} hold succeeded — transactions serialized by timing`);
  }
}

// ---------------------------------------------------------------------------
// Phase 2: SERIALIZABLE + transaction pooler — the bug
// ---------------------------------------------------------------------------

async function holdCredits(txSql, customerId, amount, idempotencyKey) {
  return txSql.begin('isolation level serializable', async tx => {
    const [{ balance }] = await tx`
      SELECT COALESCE(SUM(amount), 0)::int AS balance
      FROM credits WHERE customer_id = ${customerId}
    `;
    if (balance < amount) throw new InsufficientFundsError(balance, amount);
    const [row] = await tx`
      INSERT INTO credits (customer_id, amount, type, idempotency_key)
      VALUES (${customerId}, ${-amount}, 'HELD', ${idempotencyKey})
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING *
    `;
    return row ?? null; // null = idempotency hit (already held)
  });
}

async function runPhase2() {
  console.log('\n=== Phase 2: SERIALIZABLE + INSERT...RETURNING ghost rows ===\n');

  const customerId = `cust-ssi-${randomUUID()}`;

  // Seed: grant 100 credits
  await sql`
    INSERT INTO credits (customer_id, amount, type, idempotency_key)
    VALUES (${customerId}, 100, 'GRANT', ${`grant-ssi-${randomUUID()}`})
  `;

  const HOLD_AMOUNT = 10;
  const CONCURRENCY = 8;

  let serializationFailures = 0;
  let apparentCommits = 0;
  let bugCount = 0;

  // Run CONCURRENCY transactions simultaneously. With HOLD_AMOUNT=10 and balance=100,
  // all 8 can legitimately commit (10 x 8 = 80 ≤ 100). Under SSI, some may still get
  // serialization errors, but those that appear to commit are verified by querying the
  // row on a separate connection immediately after.
  const tasks = Array.from({ length: CONCURRENCY }, (_, i) => async () => {
    const idempotencyKey = `hold-ssi-${i}-${randomUUID()}`;
    let row;
    try {
      row = await holdCredits(sql, customerId, HOLD_AMOUNT, idempotencyKey);
    } catch (err) {
      if (err.code === '40001' || /serializ/i.test(err.message)) {
        serializationFailures++;
        return;
      }
      if (err instanceof InsufficientFundsError) {
        return; // expected once balance is exhausted
      }
      throw err;
    }

    if (row === null) return; // idempotency hit — no new row

    // The transaction returned a row, meaning it appeared to commit.
    apparentCommits++;

    // Verify the row actually exists in a separate connection.
    const [verification] = await sql`
      SELECT id FROM credits WHERE idempotency_key = ${row.idempotency_key}
    `;

    if (!verification) {
      console.error(
        `  🐛 BUG: INSERT...RETURNING returned idempotency_key=${row.idempotency_key} ` +
        `but the row is NOT FOUND after commit`
      );
      bugCount++;
    }
  });

  await Promise.all(tasks.map(t => t()));

  console.log(`  Serialization failures: ${serializationFailures} (expected — SSI working)`);
  console.log(`  Apparent commits (RETURNING returned data): ${apparentCommits}`);

  if (bugCount === 0) {
    console.log(`  ✅ All ${apparentCommits} committed rows verified — no bugs found`);
  } else {
    console.log(`  🐛 ${bugCount} of ${apparentCommits} rows NOT FOUND after commit  ← the bug`);
  }

  return bugCount;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`\n${label}`);

try {
  await runPhase1();
  const bugs = await runPhase2();
  console.log('');
  process.exit(bugs > 0 ? 1 : 0);
} catch (err) {
  console.error('\nUnexpected error:', err.message);
  process.exit(1);
} finally {
  await sql.end();
}
