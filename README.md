# Supabase Transaction Pooler Bug: Silent Data Loss on Serializable Transactions

## The Bug

**Expected behavior:** A database transaction has exactly two outcomes: it commits (data persists,
no error) or it aborts (error thrown, no data written).

**Actual behavior with the Supabase transaction pooler (port 6543):** A third outcome occurs.
Under concurrent serializable load, `sql.begin('isolation level serializable', ...)` can complete
without throwing — `INSERT...RETURNING` returns a fully populated row — but all writes are
silently discarded. The transaction neither committed nor threw. The data is simply gone.

This does not reproduce with the **session pooler** (port 5432).

## Why This Is Critical

Standard defenses against failed writes don't help here:

- **try/catch** — no error is thrown
- **Checking the RETURNING result** — a complete row object is returned
- **Re-querying after the transaction** — the row cannot be found on any connection after commit

In production this means: your application responds with success, your logs show the row was inserted — but the database
has no record. This happened to us, and we stared gobsmacked at the logs and took some debugging to find this root 
cause.

## Root Cause

Our best hypothesis: PgBouncer in transaction mode may route the `COMMIT` to a different backend
connection than the one that executed the transaction body. Under concurrent serializable load,
the `COMMIT` is then silently rejected (serialization failure at commit time), but the
`INSERT...RETURNING` result was already returned to the client before the failure was detected.
The client receives row data and no error, creating a phantom committed row. We'd welcome
Supabase's insight into the exact mechanism.

[Supabase docs](https://supabase.com/docs/guides/database/connecting-to-postgres#pooler-transaction-mode)
suggest transaction mode is "ideal for serverless or edge functions which require many transient connections." Docs
do not call out explicitly that using the transaction pooler with serializable isolation will cause this sort of
extreme and troubling behavior.

## Suggested Fix

At minimum, I suggest the docs be updated to call this out. Ideally, it would be good for the transaction pooler to 
handle this case properly.

## Prerequisites

- Node.js 18+
- pnpm
- A Supabase project with access to both pooler URLs (session on port 5432, transaction on port 6543)

## Setup

```bash
cp .env.example .env
# Edit .env — fill in your SESSION_POOL_URL and TRANSACTION_POOL_URL

pnpm install
pnpm db:migrate
```

## Reproduce

```bash
# Should pass — all rows verified, 0 bugs
pnpm test:session

# Shows the bug — rows returned by RETURNING not found after commit
pnpm test:transaction
```

## Expected Output

Phase 1 output is timing-dependent — the READ COMMITTED overdraft only manifests when concurrent transactions interleave
their reads before any commit, which varies with network latency and connection pool scheduling. Phase 2 is what
matters.

**Session pooler (port 5432) — correct behavior:**

```
--- Session Pooler (port 5432) ---

=== Phase 1: READ COMMITTED allows overdraft ===

  ℹ️  Only 1 hold succeeded — transactions serialized by timing

=== Phase 2: SERIALIZABLE + INSERT...RETURNING ghost rows ===

  Serialization failures: N (expected — SSI working)
  Apparent commits (RETURNING returned data): M
  ✅ All M committed rows verified — no bugs found
```

**Transaction pooler (port 6543) — shows the bug:**

```
--- Transaction Pooler (port 6543) ---

=== Phase 1: READ COMMITTED allows overdraft ===

  ℹ️  Only 1 hold succeeded — transactions serialized by timing

=== Phase 2: SERIALIZABLE + INSERT...RETURNING ghost rows ===

  Serialization failures: N (expected — SSI working)
  Apparent commits (RETURNING returned data): M
  🐛 K of M rows NOT FOUND after commit  ← the bug
```

The key signal is the final line of Phase 2: `✅ … no bugs found` for the session pooler vs `🐛 … NOT FOUND after commit`
for the transaction pooler.

## Why Phase 1 Matters

Phase 1 demonstrates *why* serializable isolation was chosen: without it, concurrent `READ COMMITTED` transactions can
both read a balance of 100, both decide they can afford to hold 60, and both commit — causing an overdraft. Serializable
isolation (SSI) prevents this via conflict detection. The bug in Phase 2 is that PgBouncer breaks SSI in transaction
pooling mode, making it appear that a transaction committed when it did not.

## Environment

- Confirmed with `postgres@3.4.8` (raw driver, no ORM)
- Supabase project region: `aws-1-us-east-2`
- PgBouncer transaction mode: port 6543
