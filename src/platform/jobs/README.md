# Background jobs

The transactional outbox, the BullMQ queue, and the worker runtime.

The architectural policy — what a job is, why the outbox exists, what
at-least-once means here, and how to remove the whole capability — is in
[`docs/architecture/background-jobs-and-outbox.md`](../../../docs/architecture/background-jobs-and-outbox.md).
This file is the implementation rules.

## Layout

```
config/       lazy configuration, and the two independent levels
definitions/  defineJob, the envelope, the identity, the registry
outbox/       the writer, the dispatcher, the dead-letter vocabulary
execution/    timeout, failure taxonomy, execution key, idempotent runner, processor
queue/        the ioredis connections and the single Queue
observability/ event names, the field allowlist, trace context, spans
runtime/      the worker runtime the entry point drives
```

## Rules

**Import the entry point.** Everything outside this directory uses
`@/platform/jobs/index.server`. `bullmq` and `ioredis` are imported only inside
`queue/`, and the Redis platform's driver is never imported here at all.

**Never enqueue directly.** `getJobQueue` and `requireJobQueue` are not exported
from the entry point. Work enters the queue because a committed outbox row said
so; the dispatcher is the only publisher.

**Nothing at import time.** No configuration read, no connection, no timer, no
signal handler. A module in this directory can be imported by a process that
never uses it and cost nothing.

**No signal handlers.** `src/worker` owns the process. A library that installed
one would install it in every process that imports it, including the test runner.

**Log through `logJobEvent`.** It applies the field allowlist by construction. No
module here calls the logger directly.

**Codes, never messages.** `lastErrorCode`, `deadLetterCode`, and every logged
`errorCode` come from a closed set. An exception message reaches neither a column
nor a log line nor a span.

**Bounded everywhere.** Attempts, backoff, timeout, payload size, batch size,
lease, and shutdown all have a floor and a ceiling, validated where they are
declared.

## Adding a job

1. Define it next to the module that owns the work, with `defineJob`.
2. Register it in `definitions/registry.ts`.
3. Write the outbox row inside the transaction that earns it:

```ts
await database.$transaction(async (tx) => {
  const result = await performBusinessMutation(tx);

  await writeOutboxMessage(tx, { job: MY_JOB, payload: { id: result.id } });

  return result;
});
```

4. Make the handler idempotent with `runDatabaseJobOnce`, keyed by the domain's
   own notion of "the same operation".

The payload carries identifiers, not data. No request body, no headers, no
cookies, no secrets, and nothing that does not survive `JSON.stringify`.

## Running the worker

```bash
pnpm jobs:worker        # production
pnpm jobs:worker:dev    # watch mode
pnpm jobs:outbox:once   # one dispatch pass, then exit
pnpm jobs:status        # outbox state, from PostgreSQL alone
```

The `--conditions=react-server` flag in those scripts is required, not cosmetic:
the `server-only` marker package resolves to a throwing module under the default
Node conditions.
