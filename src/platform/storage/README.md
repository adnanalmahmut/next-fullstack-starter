# `platform/storage`

Optional, S3-compatible object storage: direct browser uploads, verified and
promoted server-side, with short-lived private downloads.

Nothing here runs at import time. With `STORAGE_ENABLED=false` — the default —
no credential is read, no client is built, and no socket is opened.

See [`docs/architecture/object-storage-and-uploads.md`](../../../docs/architecture/object-storage-and-uploads.md)
for the full design, the failure semantics, and the removal procedure.

## Layout

| File                                       | What it owns                                                 |
| ------------------------------------------ | ------------------------------------------------------------ |
| `config.ts`                                | The lazy configuration and the key scope                     |
| `upload-policy.ts`                         | `defineUploadPolicy` and the shapes a policy is held to      |
| `file-declaration.ts`                      | What a client may declare, and its validation                |
| `storage-key.ts`                           | The three namespaces and server-side key generation          |
| `checksum.ts`                              | The one canonical SHA-256 form, and constant-time comparison |
| `finalize-token.ts`                        | The upload secret and the finalization lease token           |
| `safe-filename.ts`                         | The `Content-Disposition` a download may carry               |
| `content-inspector.ts`                     | The extension point for looking at the bytes                 |
| `storage-object.ts`                        | The states, the failure reasons, and the safe DTO            |
| `storage-repository.server.ts`             | The only data access; every write is conditional             |
| `create-upload-intent.server.ts`           | Authorizes one upload of one file                            |
| `finalize-upload-intent.server.ts`         | Claim, verify, inspect, promote, commit                      |
| `create-storage-download-url.server.ts`    | A short-lived private link                                   |
| `get-storage-object-metadata.server.ts`    | What a module may know, from PostgreSQL alone                |
| `cleanup-expired-upload-intents.server.ts` | The bounded, unscheduled cleanup contract                    |
| `health.server.ts`                         | `disabled` / `healthy` / `unavailable` / `misconfigured`     |
| `provider/storage-provider.ts`             | The provider-neutral port                                    |
| `provider/s3-storage-provider.server.ts`   | The one adapter, and the only AWS SDK imports                |
| `provider/storage-client.server.ts`        | The lazy client and its lifetime                             |

## Using it

```ts
import {
  createStorageDownloadUrl,
  createUploadIntent,
  defineUploadPolicy,
  finalizeUploadIntent,
} from "@/platform/storage/index.server";

// Module-level, in server-owned code. Never built from a request.
const invoiceUpload = defineUploadPolicy({
  name: "billing.invoice",
  allowedFiles: [{ contentType: "application/pdf", extensions: ["pdf"] }],
  maxBytes: 5 * 1024 * 1024,
});

// In an ordinary JSON action, after the module has authorized the caller.
const intent = await createUploadIntent({
  policy: invoiceUpload,
  file: {
    contentType: "application/pdf",
    extension: "pdf",
    sizeBytes: 182_400,
    checksumSha256: "…64 lowercase hex characters…",
  },
});

// The browser posts the bytes straight to `intent.upload`. Then, in a second
// action, again after authorizing:
const { object } = await finalizeUploadIntent({
  intentId,
  finalizeToken,
  policy: invoiceUpload,
});

// The module stores `object.id` and nothing else — not the key, not the bucket.
const link = await createStorageDownloadUrl({
  objectId: object.id,
  filename: "invoice-2026-04.pdf",
});
```

## Four things this platform does not do

- **It does not authorize.** No function here takes an actor. Who may upload and
  who may download are the calling module's decisions, because the relationship
  that answers them lives entirely in the module.
- **It does not make anything public.** No ACL, no public bucket, no CDN. Every
  download is a signature measured in minutes.
- **It does not know what the bytes are.** A declared media type is a guess and
  a SHA-256 is an integrity check. Judging content needs a
  `StorageContentInspector`, and this repository implements none.
- **It does not schedule anything.** `cleanupExpiredUploadIntents` is a contract
  a deployment wires to its own scheduler. There is no cron, no queue, and no
  worker.

## Local development

```bash
cp compose.storage.env.example compose.storage.env   # then set the credentials
pnpm storage:up            # development MinIO on 127.0.0.1:9000, console on :9001
pnpm storage:test:up       # ephemeral test MinIO on 127.0.0.1:9100
pnpm test:storage:integration
pnpm storage:test:down
```

`pnpm db:up` and `pnpm redis:up` never start MinIO, and `pnpm storage:down`
never stops PostgreSQL or Redis.
