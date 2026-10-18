---
description: "Buracle path rule: Backend (injected when editing or writing matching files)"
condition:
  - "**/api/**"
  - "**/routes/**"
  - "**/handlers/**"
  - "**/controllers/**"
  - "**/endpoints/**"
  - "**/middleware/**"
  - "**/models/**"
  - "**/models.py"
  - "**/entities/**"
  - "**/schema/**"
  - "**/schemas/**"
  - "**/queries/**"
  - "**/repository/**"
  - "**/repositories/**"
  - "**/dao/**"
  - "**/migrations/**"
  - "**/migrate/**"
  - "**/alembic/**"
  - "**/db/**"
  - "**/*.sql"
  - "**/*.prisma"
  - "**/*.graphql"
  - "**/*.proto"
  - "**/openapi*.yaml"
  - "**/openapi*.yml"
  - "**/openapi*.json"
---
# Backend

## API design
- Keep existing contracts stable: paths, methods, status codes, field names, error shape, pagination and auth. A breaking change needs a new version or the user's explicit approval.
- Use status codes precisely (201 created, 204 no content, 400 or 422 for invalid input per repo convention, 401 unauthenticated, 403 forbidden, 404, 409 conflict, 429 rate-limited) and one consistent error body.
- Paginate list endpoints and cap page size and request body size.
- Update the API description (OpenAPI, GraphQL schema, protobuf) in the same change as the code.

## Validation and authorization
- Validate every input at the boundary — body, query, path parameters, headers — with the project's schema library. Reject malformed or unexpected fields and normalize before use.
- Authenticate, then authorize per object: check that the caller may touch this specific record, not merely that they are logged in. Never trust ids, roles or prices sent by the client.
- Parameterize every query. Never build SQL, shell commands or file paths from raw input. Identifiers and sort expressions (`ORDER BY` columns, directions) cannot be bound as values: map them through an allowlist or the query builder's safe API.

## Data models
- Enforce integrity in the database (NOT NULL, UNIQUE, foreign keys, CHECK), not only in application code.
- Store money as integer minor units or fixed-precision decimals and timestamps in UTC with a time zone; give strings and numbers explicit lengths and precision.
- Index for real query patterns and confirm with `EXPLAIN` on realistic data. Avoid N+1 queries by batching or eager loading.
- Wrap multi-step writes in a transaction; keep transactions short and free of network calls.
- A transaction alone does not stop lost updates. For read-modify-write, use optimistic locking (a version column) or `SELECT … FOR UPDATE`, or an atomic `UPDATE … SET n = n + 1`.

## Migrations
- Never edit a migration that has run anywhere shared; add a new one.
- Make each migration reversible, or write down the recovery path before it runs. A schema-only rollback cannot bring back data a destructive migration deleted: say so, and name the backup to restore from.
- Never invent a meaningless default just to satisfy a new NOT NULL column on a populated table; backfill real values first, then add the constraint.
- Applying migrations to a shared or live database needs the user's permission.
- For large or busy tables, use expand → migrate → contract: add nullable columns or new tables, backfill in batches, switch reads and writes, then enforce constraints and drop the old shape in a later migration.
- Keep schema changes and data backfills in separate steps. Test up (and down) against a disposable copy, never the real database.

## Idempotency and reliability
- Assume every request, message and job can arrive twice. Make writes idempotent: idempotency keys on create and payment endpoints, upserts on natural keys, de-duplication in consumers, and jobs and backfills that can be re-run safely.
- Give every outbound call a timeout. Retry only idempotent operations, with a bounded number of attempts, exponential backoff and jitter.
- Shut down gracefully: stop accepting work, finish or requeue what is in flight, close pools.

## Security and observability
- Secrets come from the environment or a secret store, never from code, committed config or logs.
- Log with structure and a request id. Never log tokens, passwords or personal data, and don't leak internals in error responses.
- Rate-limit authentication and other expensive endpoints; keep CORS as narrow as the real clients require.

## Verification
- Exercise changed endpoints for real: run the server and call it (curl, httpie), or write integration tests against a real database (for example a disposable container) when SQL or transaction behavior matters. Mocks cannot prove database semantics.
- Check ORM, framework and driver APIs with context7 at the installed version.
