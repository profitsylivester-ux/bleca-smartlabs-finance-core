-- M14: Reporting & Exports.
-- No report/export tables are needed: reports are computed server-side from
-- JournalLine / Transaction / Budget / OpeningBalance. What M14 does need is a
-- home in the audit trail for "a report was viewed" and "a report was exported".
-- The AuditAction values EXPORT and REPORT_GENERATED already exist; this adds the
-- matching AuditEntityType values so an export can be logged against the REPORT
-- it produced and the EXPORT event it represents (PDF 49: every export is logged
-- with its format and filter set).

-- AlterEnum
ALTER TYPE "AuditEntityType" ADD VALUE IF NOT EXISTS 'REPORT';

-- AlterEnum
ALTER TYPE "AuditEntityType" ADD VALUE IF NOT EXISTS 'EXPORT';
