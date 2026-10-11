# M7 Sub-Tasks

1. **Treasury Account CRUD + Seed** — Create `treasury_accounts` Prisma model + migration; seed all `TreasuryAccountKind` variants (cash, bank, mobile money, payment gateway, project fund, grant fund, other) linked to ledger accounts; encrypt sensitive fields (account numbers, API keys); API `/api/v1/treasury-accounts` CRUD; UI `/treasury/accounts` list + detail.

2. **Deposits, Withdrawals, Payments, Receipts** — Implement ledger-backed document generators for each treasury action; each creates a balanced `JournalEntry` (source = TRANSACTION); API routes `POST /treasury-accounts/:id/deposit|withdrawal`; UI `/treasury/cash`, `/treasury/bank`, `/treasury/mobile-money`, `/treasury/gateways` with action buttons.

3. **Transfers (Core Invariant)** — Implement `transfers` model + API CRUD + workflow (submit → approve → process → reverse); **transfer = single balanced JournalEntry** with credit on source account line, debit on destination account line; cross-currency produces FX difference entry; rejection on locked period; reversal creates reversing entry + links; test: *bank→mobile-money transfer leaves revenue/expense unchanged*.

4. **Payment Schedules** — Create `payment_schedules` model; CRUD API `/api/v1/payment-schedules`; due/overdue status computation; link to treasury accounts and funding sources; UI `/treasury/payment-schedules` list with filters.

5. **Cash Position + Liquidity View** — Implement `GET /api/v1/cash-position` aggregating balances from `JournalLine` sums per treasury account; liquidity view by currency + account kind; UI `/treasury/cash-position` dashboard; test: *account balances equal sum of their journal lines*; *restricted grant accounts reject non-eligible transactions*.