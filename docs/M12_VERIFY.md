# M12 Document Management verification

## Database

The M12 schema is applied by these migrations:

- `20261012122908_m12_documents`
- `20261012123128_m12_document_integrity`
- `20261012125909_m12_document_tenant_scope`

The integrity migration makes `document_versions` append-only and enforces one active legal hold per entity and one primary document link per linked entity. The tenant-scope migration adds organization foreign keys to document versions, links, tags, and holds.

Apply pending migrations with `npm run db:migrate` (or `node node_modules/prisma/build/index.js migrate dev`).

## Storage and validation

Storage is selected by `STORAGE_DRIVER`:

- `local` writes private files beneath `STORAGE_LOCAL_ROOT/documents/`.
- `s3` uses the S3-compatible endpoint and credentials in `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY`. Set `S3_FORCE_PATH_STYLE` for compatible local endpoints.

Upload defaults are 15 MiB, PDF/JPEG/PNG, and a five-minute download URL. Configure them with `DOCUMENT_MAX_FILE_BYTES`, `DOCUMENT_ALLOWED_MIME_TYPES`, and `DOCUMENT_SIGNED_URL_TTL_SECONDS` (30–900 seconds). Uploads are checked against both the declared MIME type and the file signature. The Phase 1 virus scanner logs and passes through; OCR remains `NOT_RUN` through the Phase 1 adapter.

The existing development Compose service is Adobe S3Mock on port 4566. It is S3-compatible and uses credentials from the environment. The application does not contain S3 credentials. Compose uses S3Mock rather than MinIO because the repository's current Compose file records that its MinIO image was no longer pullable; production remains any S3-compatible provider.

## Manual flow

1. Start the database and web application, then sign in with a role granted `DOCUMENTS.VIEW` and `DOCUMENTS.CREATE`.
2. Open `/documents/upload`, upload a PDF/JPEG/PNG, and confirm the detail page shows version 1, `NOT_RUN` OCR, and the document metadata.
3. Request approval. A user assigned to the active `DOCUMENT` approval policy can approve or reject through the existing approval workflow; the submitter cannot self-approve.
4. Add a tag and a link to a same-organization transaction, invoice, payment, receipt, quotation, supplier, customer, project, funding source, journal entry, treasury account, budget, or reconciliation session.
5. Preview/download the file. The returned first-party URL expires and the actual download request is audited.
6. Add another version with a reason. The prior version remains available in history, and the database rejects update/delete attempts against version rows.
7. Configure a category policy under `/documents/retention`, set an expiry date, and inspect `/documents/expiring`. Place a legal hold and verify that archive/delete actions are refused until a release reason is recorded.
8. For account-level evidence, mark an account `requiresDocument` and try to post a transaction without an attached supporting document or active evidence link. Posting is refused.

The M12 maintenance entry point is `runDocumentMaintenance()` in `src/lib/documents/maintenance.ts`. M17 can schedule it; it is not wired to a cron endpoint in Phase 1.

## Automated checks

Run the repository typecheck and the integration suite:

```powershell
npx tsc --noEmit
npm run test:integration 2>&1 | Select-Object -Last 5
```

`src/tests/integration/m12-documents.test.ts` covers upload validation, checksum dedupe, URL expiry, audited access denial and success, database-enforced version immutability, legal holds, retention skipping, required transaction evidence, expiry reminders, and tenant-scoped search.
