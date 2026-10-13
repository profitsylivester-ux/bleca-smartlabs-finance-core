# ADR-001: Use Next.js App Router

## Status
Accepted

## Date
2026-10-13

## Context
We need to choose a frontend framework and routing paradigm for the BLECA SmartLabs Finance application. The requirements include:
- Server-side rendering for security-sensitive financial pages
- API routes for external integrations
- TypeScript support
- Good developer experience for a small team (2 developers in Phase 1)
- Deployable to Vercel with minimal configuration

Options considered:
1. Next.js Pages Router (legacy)
2. Next.js App Router (current)
3. Remix
4. TanStack Start
5. Plain React + Vite + custom backend

## Decision
We will use **Next.js App Router** (Next.js 14+) with the following configuration:
- Server Components by default for all pages
- Server Actions for mutations (co-located with UI)
- Route Handlers under `app/api/v1/**` for external API surface
- TanStack Query only for genuinely client-interactive, high-refresh views
- Vercel as deployment target

## Consequences

### Positive
- **React Server Components**: Sensitive financial data never sent to client; rendering happens on server
- **Single deployment**: Frontend + API in one Next.js app, no separate backend service
- **TypeScript end-to-end**: Shared types between server and client via Prisma generated types
- **Vercel native**: Zero-config deployment, edge functions, automatic HTTPS
- **Streaming & Suspense**: Progressive rendering for complex financial reports
- **Server Actions**: Mutations with automatic CSRF protection, no API boilerplate
- **File-system routing**: Convention over configuration, easy to understand

### Negative
- **Learning curve**: App Router paradigms (Server Components, Server Actions) differ from traditional SPA patterns
- **Vendor lock-in**: Tied to Vercel/Next.js ecosystem (mitigated by standard React patterns)
- **Bundle size**: Next.js includes more framework code than minimal Vite setup
- **Caching complexity**: Next.js caching layers (fetch, Router, Data) require understanding

### Risks & Mitigations
| Risk | Mitigation |
|------|------------|
| Team unfamiliar with Server Components | Pair programming, internal docs, code reviews |
| Caching bugs in financial data | Explicit `no-cache` on all financial queries, `unstable_noStore()` |
| Server Action limits (payload size) | Use Route Handlers for large payloads (file uploads) |
| Vercel cold starts | Keep functions warm with cron, use Edge where possible |

## Related Decisions
- ADR-002: Kernel/Module Separation (App Router pages import from modules, modules import from kernel)
- ADR-003: Append-Only Audit Trail (Server Actions ensure audit in same transaction)

## References
- Next.js App Router Documentation: https://nextjs.org/docs/app
- PHASE_1_PLAN.md §2.1, §2.2
- BLECA_SMARTLABS_financial_website_requirements.pdf §70