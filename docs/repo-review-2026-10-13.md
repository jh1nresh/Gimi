# Gimi repository review — 2026-10-13

## Scope and acceptance

Review source at `682b2ad` and fix reproducible authorization, availability,
and payment-state binding failures without changing payment-provider contracts,
on-chain programs, production data, credentials, or deployments. Positive
flows must still work; rejected requests must not mutate rental state or create
provider checkouts. Delivery is a reviewed PR; merge and deployment are separate.

The review covered the Next API routes and their repositories, the static rental
UI and Privy signing bridge, payment adapters, Solana rental confirmation,
readiness configuration, dependency lockfile, tests, and CI. This is a source
review with local mocked integration evidence, not a live payment or complete
security certification.

## Reproduced and fixed

| Finding | Before | After and evidence |
| --- | --- | --- |
| Listing authorization | Supplying the public owner wallet was sufficient to pause/unpause inventory. | A fresh wallet signature binds the listing ID and requested action. UI signs before PATCH; missing, forged, stale, or cross-listing proofs fail. `listingAuthorization.test.ts`, `listingOwnerUi.test.ts`. |
| Base confirmation configuration | A deployed endpoint without its shared secret accepted caller-attested payments. | Missing/blank secrets fail closed in production and Vercel; wrong bearer tokens fail; local demo remains explicit. Reused transaction IDs cannot bind to a different item/renter. `baseConfirmation.test.ts`. |
| Unavailable inventory | Paused/rented inventory could enter several rental or payment creation routes. | Card/Solana intent, Solana Pay, Base prepare/confirm, MCP, voice and MoonPay checkout reject unavailable inventory before new funding work. Matching Base replay remains idempotent. `checkoutAvailability.test.ts`, payment route tests. |
| MoonPay payment identity | Metadata could select a different intent/payment rail, and checkout creation could overwrite a concurrent webhook update. | Webhooks verify payment rail, provider and payment identity; checkout uses compare-and-save and preserves the original canonical payment on retry. A bound payment with no checkout URL needs reconciliation. `moonpayRoutes.test.ts`. |
| Solana intent identity | A valid rental could be synchronized into an unrelated intent supplied by the caller. | Item, owner, renter, rental ID, payment rail and session state must match before RPC/persistence; concurrent intent updates are preserved. Wallet-only confirmation remains supported. `rentalStartBinding.test.ts`. |
| Dependency drift | Current registry audit reported 50 affected package nodes, including one critical. | Compatible framework/transitive patches reduce this to 37 and zero critical; the four newly observed upstream advisories still block readiness. See `dependency-security.md`. |

## Verification

- Original repository suite: 32 passing tests.
- New route/UI regression suite against original source: 62 failures and 17
  passes, demonstrating the unpatched behavior (before two later retry tests).
- Final source: 113 passing tests across 14 files, plus successful TypeScript,
  ESLint and Next.js 16.3.8 production build on Node 22.22.3.
- The independent reviewer reproduced the payment issues and checked the fixes;
  checkout retry initially exposed an identity replacement bug, now covered by
  retry-then-original-webhook regression evidence.
- `npm run audit:runtime` fails on four upstream advisory URLs. The allowlist and
  required CI gate are unchanged. The PR is **pending**, not production-ready.
- No real provider charge/refund, wallet signature, chain transaction, database
  migration, merge or deployment was performed. Rust/Anchor code was unchanged.

## Remaining work, in order

1. **Unblock dependency security without breaking wallet SDKs.** Upgrade the
   legacy decoder/RPC parents with targeted browser and JSON-RPC compatibility
   tests. Existing bigint-buffer, UUID and WebSocket advisories also remain;
   no critical findings does not mean a clean audit.
2. **Verify payment facts before real-money operation.** Base confirmation still
   trusts an authorized caller's assertion; `txHash` syntax is not receipt,
   amount, recipient, token or finality verification. MoonPay's generic webhook
   adapter maps status without validating amount/currency or querying canonical
   provider payment details. Final provider schemas and network configuration
   must be established before implementing that validation.
3. **Make storage durable and multi-instance safe.** The listing, intent and
   session repositories fall back to `/tmp` on Vercel when Supabase is absent;
   photo uploads also use temporary local files. Use configured durable storage
   and verify database constraints/atomic reservations before concurrent real
   rentals. The availability checks here are not an atomic inventory reservation.
4. **Connect the renter catalogue to published inventory.** `public/gimi.html`
   initializes `ITEMS` as a static demo catalogue. Owner inventory is fetched
   separately. New owner listings therefore do not automatically become a live
   renter marketplace; define visibility/search behavior and connect the data
   before claiming that product flow is complete.
5. **Run hosted acceptance after configuration.** Verify owner signing/cancel,
   publish/browse, checkout retry, signed webhooks, handoff, return/refund and
   durable reads across instances. Local route mocks cannot prove provider or
   browser integration, nor the currently deployed Vercel configuration.
