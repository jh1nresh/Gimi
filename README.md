# Gimi

Gimi is an AI rental agent for community inventory: chat-to-rent discovery, Card, Solana, or Base MCP checkout preparation, escrow-backed returns, and on-chain receipts.

The product is built for schools, coworking spaces, apartment communities, and hackathon venues where people need to borrow real items from nearby owners. Gimi handles inventory search, rental intent creation, refundable deposit/funding, hourly rent accrual inside escrow, owner return confirmation, card-funded receipt issuance, and reputation-ready history.

The current demo opens at `/` and renders the Gimi one-page agent shell from `public/gimi.html` inside a Next controller shell: a large central agent orb, a bottom chat input, nearby inventory, a product checkout drawer, and same-page Privy connection for email or Solana wallet users.

## Product Loop

```text
User asks for an item
-> Agent searches community inventory
-> Agent selects the best available item
-> Gimi creates a rental intent with duration, rent, deposit, and proof model
-> Renter chooses Card or Solana wallet at checkout
-> Card path authorizes rent plus deposit with a payment provider and keeps Solana as the receipt rail
-> Solana path asks Privy to sign/send the prepared start_rental transaction
-> Gimi Anchor program locks buyout-cap USDC escrow and creates rental session state for wallet checkout
-> Renter receives a program-owned rental token PDA on the Solana path
-> Rent accrues hourly inside escrow
-> Owner confirms physical return, or auto-buyout triggers after grace
-> Rental token closes, accrued rent splits to host/platform, renter refund settles, receipt event is emitted
```

The MVP is designed for physical-world rentals where the agent helps people borrow real items from a school, community, apartment, coworking space, or hackathon venue.

## What Is Implemented

- Gimi one-page agent shell at `/`, rendered by `src/app/page.tsx` with `public/gimi.html` as the visual shell.
- Central orb plus bottom chat input for natural-language rental requests.
- Clickable nearby inventory and product checkout drawer.
- Payment-router checkout with one user-facing action, Card and Solana wallet options, and a shared rental intent record before funding.
- Same-page Privy controller for direct email or Solana wallet login. The controller signs a Solana sign-in message before the shell stores a wallet session.
- Wallet session reuse: once Privy connects, the checkout drawer changes from `Connect wallet` to `Start rental` instead of asking the user to connect again.
- Demo inventory, rental session state, return flow, receipt copy, and reputation-ready result.
- Receipt/history page for recent settled rentals, item context, wallet parties, payout/refund split, and Solana explorer links.
- Active rental profile showing escrow locked, rent accrued so far, and estimated renter refund if returned now.
- Anchor `rental_session` program for SPL-token escrow and rental lifecycle.
- Public generated IDL at `/idl/rental_session.json`.
- Owner listing flow that prepares an owner-signed `initialize_item` devnet transaction, verifies the confirmed item PDA, and publishes it into renter inventory.
- Supabase-backed listing storage when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are configured, with local file fallback for development.
- Supabase-backed rental intent storage when configured, with local file fallback for development.
- Program-aware Solana Pay endpoints returning unsigned serialized wallet transactions for `initialize_item`, `start_rental`, `confirm_return`, and `auto_buyout`.
- Wallet signing/sending through Privy Solana wallets from the active Gimi shell.
- LI.FI quote endpoint at `/api/lifi/quote` using live LI.FI REST quotes when real source/destination wallets are supplied, with demo fallback for local UI mode.
- ElevenLabs server tools endpoint at `/api/elevenlabs/tools`.
- MCP-style read/prepare endpoint at `/api/mcp`.
- Base MCP plugin endpoints at `/api/base-plugin/gimi` for agent-callable inventory search, quote, and Base USDC deposit-call preparation.
- Privy React provider and bridge CTA for real wallet onboarding. The UI does not mint a fake renter wallet when Privy is not configured.

## Track Alignment

| Track | Implementation |
| --- | --- |
| Solana | Anchor program for escrow, rental sessions, rental-token PDA lifecycle, receipt events, and auto-buyout |
| LI.FI | `/api/lifi/quote` calls LI.FI REST for Base USDC to Solana USDC routes and returns the LI.FI transaction request when real wallet addresses are supplied |
| ElevenLabs | `/api/elevenlabs/tools` exposes server tools for inventory search, terms drafting, LI.FI funding quotes, and unsigned Solana rental transactions |
| Virtuals | Agent perceives inventory, decides best item, and acts around physical-world handoff/return workflows |
| MCP | `/api/mcp` exposes read/prepare rental tools for external agents |
| Base MCP | `/api/base-plugin/gimi` exposes Base agent endpoints for inventory, quote, and user-approved USDC deposit calldata |
| Solana Pay | `/api/solana-pay/initialize-item`, `/api/solana-pay/start-rental`, `/api/solana-pay/confirm-return`, and `/api/solana-pay/auto-buyout` return Solana Pay-style request payloads plus program id, PDA accounts, required signer, and instruction args |
| Privy | `@privy-io/react-auth` provides email onboarding and embedded or external Solana checkout wallets through `NEXT_PUBLIC_PRIVY_APP_ID` |

## Local Development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

For wallet login, create `.env.local`:

```bash
NEXT_PUBLIC_PRIVY_APP_ID=YOUR_PRIVY_APP_ID
```

The optional Stripe Redbox path also verifies Privy access tokens on the server.
Copy the JWT verification public key from the Privy dashboard and preserve its
PEM line breaks:

```bash
PRIVY_JWT_VERIFICATION_KEY="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
```

The production Vercel project must also have `NEXT_PUBLIC_PRIVY_APP_ID` configured. Without it, Gimi shows a setup screen instead of the rental shell.

Use `.env.example` as the full production checklist. The app also exposes a
secret-safe readiness endpoint:

```bash
curl -s http://localhost:3000/api/health/readiness
```

It returns which required/recommended keys are present without returning secret
values. Required production keys are `NEXT_PUBLIC_PRIVY_APP_ID`, `SUPABASE_URL`,
and `SUPABASE_SERVICE_ROLE_KEY`.

Every recorded agent execution event carries explicit provenance. Keep local
and preview deployments labeled as demo/test activity; change these values only
when a real operator pilot or organic production surface exists:

```bash
GIMI_ENVIRONMENT=local
GIMI_ACTIVITY_TYPE=seeded_demo
```

The current partner-diligence package is in
[`docs/partner-diligence`](docs/partner-diligence/architecture.md). For a local,
clearly labeled end-to-end fixture run `npm run demo:seed`, then open
`http://localhost:3000/?demo=partner` and select **My rentals**. The fixture
creates no provider charge or chain transaction.

For Base MCP deposit-call preparation, set `BASE_RENTAL_ESCROW_ADDRESS` to the
escrow wallet or contract address. `BASE_MCP_CHAIN` defaults to `base-sepolia`.

Useful checks:

```bash
npm run lint
npm run build
npm run test:anchor
npm run devnet:setup
npm run demo:ensure-items
npm run demo:check-items
npm run e2e:devnet
```

`demo:ensure-items` idempotently initializes every product shown in the demo
catalog under the configured devnet owner. `demo:check-items` is read-only and
fails if any displayed Item PDA is missing or no longer available.

## Supabase

Gimi uses Supabase for durable published listing and rental-session storage. Run the migrations in:

```text
supabase/migrations/001_create_listings.sql
supabase/migrations/002_create_rental_sessions.sql
supabase/migrations/003_create_rental_receipts.sql
supabase/migrations/004_create_rental_intents.sql
supabase/migrations/005_add_card_settlement_fields.sql
supabase/migrations/006_add_card_receipt_fields.sql
supabase/migrations/007_add_paused_listing_status.sql
supabase/migrations/008_create_notifications.sql
supabase/migrations/009_add_base_mcp_rental_intents.sql
supabase/migrations/010_create_rental_execution_events.sql
```

Then configure these server-side environment variables:

```bash
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
```

`SUPABASE_SERVICE_ROLE_KEY` must stay server-only. Do not prefix it with
`NEXT_PUBLIC_`.

If those env vars are missing, the app falls back to local file storage at
`.rentproof/listings.json`, `.rentproof/rental-sessions.json`,
`.rentproof/rental-receipts.json`, and `.rentproof/rental-intents.json`
locally, and `/tmp/*` JSON files on Vercel.
The Vercel fallback is ephemeral and should only be used for smoke tests.

## Payment Router

Gimi separates payment rails from proof rails:

```text
Rental intent
-> Card checkout or Solana wallet checkout
-> Rental session
-> Return confirmation / settlement
-> Solana receipt / reputation record
```

Card users should not need crypto to reserve an item. The preferred migrated
rail is a Stripe TEST-mode Redbox flow: the user links a card after Privy login,
Gimi authorizes the refundable buyout cap, and no money is captured until the
owner confirms return and signs the Solana receipt transaction. At that point
Gimi captures only the final rental fee and releases the unused authorization.

```bash
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_SECRET_KEY=sk_test_...
PRIVY_JWT_VERIFICATION_KEY="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
```

Live Stripe keys are deliberately rejected in this migration. This keeps the
new payment path testable without presenting it as production money movement.
The Stripe customer, authorization, and receipt are joined by Privy user id and
the existing `rental_intents` id; no second rental store or schema is introduced.

When the Stripe TEST variables are absent, the same Card button falls back to
the existing MoonPay Commerce flow:

```bash
MOONPAY_COMMERCE_API_URL=https://...
MOONPAY_COMMERCE_API_KEY=...
MOONPAY_COMMERCE_WEBHOOK_SECRET=...
MOONPAY_COMMERCE_SUCCESS_URL=https://...
MOONPAY_COMMERCE_CANCEL_URL=https://...
MOONPAY_COMMERCE_WEBHOOK_URL=https://YOUR_DOMAIN/api/payments/moonpay/webhook

# Optional hosted-link fallback when the API URL/key are not available:
MOONPAY_COMMERCE_CHECKOUT_URL=https://...
```

Without either Stripe TEST configuration or MoonPay API env vars/hosted checkout,
the app shows a setup message instead of pretending to charge the user. A
MoonPay webhook marks the intent funded, sets escrow to provider-authorized or
provider-captured, reserves the rental, and leaves the Solana receipt pending
for return settlement.

Solana wallet users keep the existing path: Privy opens in-page, the wallet
signs the serialized devnet transaction, `start_rental` locks USDC into escrow,
and `/api/rentals/start` persists the active session.

## Privy Wallet Flow

The static Gimi visual shell cannot call Privy hooks directly, so `/` renders a small React controller around it. The visible shell sends wallet requests to the parent page with `postMessage`; the parent page opens Privy's modal directly in the same page and then asks the Solana wallet to sign a Gimi sign-in message.

```text
public/gimi.html
-> posts gimi:request-privy-connect to the parent Next page
-> parent opens the Privy modal directly on the current page
-> parent asks the connected wallet to sign a Gimi sign-in message
-> parent posts the signed wallet session back to the shell
-> shell writes gimi.walletSession and updates the checkout drawer
```

For rental checkout, `public/gimi.html` stores the prepared base64 transaction in
`gimi.pendingPrivyTransaction` and asks the parent controller to sign/send it:

```text
gimi:request-privy-transaction
```

The parent controller signs and sends through the connected Privy Solana wallet, then posts
the devnet signature to the shell so `/api/rentals/start` can persist the rental
session and update listing status.

## Escrow And Metering Model

Gimi does not stream funds directly to the host every hour in the MVP. The renter funds the buyout-cap amount into program escrow at `start_rental`. Time then marks an internal accrued-rent balance: `max(minimum_fee, elapsed_time * rate_per_second)`, capped by the escrow amount. On settlement, that accrued rent is split into owner payout and platform fee.

The preferred MVP settlement path is:

```text
renter funds escrow
-> session stays active while rent accrues inside escrow
-> renter requests return when the item is physically handed back
-> owner confirms return
-> program splits accrued rent into owner payout + platform fee
-> program refunds the remaining escrow to renter
```

`confirm_return` bills against the renter's on-chain return-request timestamp when present, capped at the scheduled due time. This prevents a host from delaying confirmation just to consume more of the escrow. `auto_buyout` handles the case where the item does not come back after due time plus grace; any keeper can trigger it, but escrow still settles only to the owner/platform destination accounts. Partial host withdraw before return is intentionally out of scope because it adds dispute and refund complexity.

## Anchor Program

Program path:

```text
programs/rental_session
```

Program id:

```text
AVL316tYxrg8MhEeWtaxbwdShMWybzRAH1zNQWvX355K
```

Build:

```bash
npm run anchor:build
```

Devnet setup:

```bash
npm run devnet:setup
```

Instructions:

- `initialize_config` sets platform fee authority and fee bps. The initializer is pinned to the platform authority to prevent config squatting.
- `initialize_item` records owner, payment mint, metered rate, minimum fee, buyout cap, and auto-buyout grace window.
- `start_rental` transfers the full SPL-token buyout cap from renter to escrow, creates `RentalSession`, starts metered rent accrual, and creates the non-transferable `RentalToken` PDA.
- `request_return` records a renter-signed return-request timestamp while the session remains active.
- `confirm_return` settles accrued rent into platform fee and owner payout, refunds the renter remainder, closes escrow, closes rental token, and emits `RentalReturned`.
- `auto_buyout` lets any keeper settle the buyout cap to owner/platform accounts after due time plus grace, closes escrow/token state, marks the item bought out, and emits `RentalBoughtOut`.

The rental token is intentionally a program-owned PDA account, not a transferable SPL token. That keeps the rental right bound to the session and prevents a renter from transferring away the obligation.

## API Surface

### `POST /api/solana-pay/initialize-item`

Prepares an owner-signed devnet `initialize_item` transaction for a new listing. The server canonicalizes the item metadata, hashes it, derives the item PDA, and returns a base64 transaction.

Example request:

```bash
curl -s -X POST http://localhost:3000/api/solana-pay/initialize-item \
  -H 'content-type: application/json' \
  -d '{"ownerWallet":"7Fmr5t2h2SZ55n4w3dkgWTjaXRafDnBLLy1RhdmPJk6b","name":"Anker Power Bank","brand":"Anker","model":"20K USB-C","category":"Power","condition":9,"description":"High-capacity USB-C power bank with cable.","imageUrl":"https://images.unsplash.com/photo-1609091839311-d5365f9ff1c5?w=900&h=700&fit=crop","locationLabel":"Library desk","included":["USB-C cable"],"ratePerHour":2,"minimumFee":3,"buyoutCap":30,"autoBuyoutGraceSeconds":3600}'
```

Response includes:

- `draftId`
- `itemPda`
- `metadataHash`
- `listingPreview`
- `transaction`
- `transactionMetadata.requiredSigner`

### `POST /api/listings/publish`

Publishes a listing after the owner has signed and sent `initialize_item`. The server checks the devnet signature, verifies the item PDA is owned by the Gimi program, decodes the on-chain `RentalItem`, checks pricing and hashes, then stores the listing.

### `GET /api/listings`

Returns published listings plus renter-ready inventory. The renter agent uses this endpoint first and falls back to seeded demo inventory when no published listing exists.

Pass `ownerWallet` to load owner inventory for the profile management tab,
including paused and rented listings:

```bash
curl -s "http://localhost:3000/api/listings?ownerWallet=OWNER_WALLET&limit=20"
```

### `PATCH /api/listings`

Lets an owner pause or re-enable a listing that is not currently locked by a
rental.

```bash
curl -s -X PATCH http://localhost:3000/api/listings \
  -H 'content-type: application/json' \
  -d '{"id":"item_...","ownerWallet":"OWNER_WALLET","status":"paused"}'
```

Supported owner-managed statuses are `available` and `paused`. Rented,
return-requested, buyout, and disputed items must move through the rental
settlement flows instead.

### `POST /api/uploads/item-photo`

Uploads an owner item photo and returns an `imageUrl` that can be used in the
listing initialization form.

```bash
curl -s -X POST http://localhost:3000/api/uploads/item-photo \
  -F ownerWallet=OWNER_WALLET \
  -F photo=@/path/to/item-photo.png
```

Local development stores files under `.rentproof/item-photos`; Vercel preview
uses `/tmp`, so production should replace this adapter with durable object
storage such as Supabase Storage.

### `GET /api/notifications`

Returns the renter/owner notification feed shown in the profile drawer.

```bash
curl -s "http://localhost:3000/api/notifications?wallet=OWNER_OR_RENTER_WALLET&limit=8"
```

Notifications are written when card handoff is marked active, card return
economics are recorded, card Solana receipts are issued, and owner listing
availability changes.

### `GET /api/health/readiness`

Returns production environment readiness without exposing secret values.

```bash
curl -s http://localhost:3000/api/health/readiness
```

The endpoint returns `200` when required keys are configured and `503` when a
required key is missing. `productionReady` is stricter and also requires
recommended integrations such as MoonPay webhook signing and ElevenLabs.

### `POST /api/solana-pay/start-rental`

Returns a Solana Pay request payload, Gimi PDA metadata, and an unsigned serialized devnet transaction for the renter wallet to sign.

### `POST /api/rentals/intent`

Creates the shared checkout intent used by Card and Solana wallet rentals.

```bash
curl -s -X POST http://localhost:3000/api/rentals/intent \
  -H 'content-type: application/json' \
  -d '{"itemId":"power_bank_18","hours":3,"paymentMethod":"card"}'
```

For `paymentMethod: "card"`, the response includes the rent, deposit, provider
slot, and whether a card checkout URL is configured. For
`paymentMethod: "solana_wallet"`, the intent is created first and the UI then
prepares the existing Solana `start_rental` transaction with the same rental id.

### `POST /api/rentals/intent/status`

Updates a card-funded rental intent after payment. The current supported action
is owner handoff activation:

```bash
curl -s -X POST http://localhost:3000/api/rentals/intent/status \
  -H 'content-type: application/json' \
  -d '{"intentId":"intent_...","ownerWallet":"OWNER_WALLET","action":"mark_handed_off"}'
```

The route requires the MoonPay/card payment to be confirmed and the provider
escrow state to be `provider_authorized` or `provider_captured`. It then marks
the card reservation `session_status=active` and keeps
`receipt_status=pending_onchain` until the return-settlement flow issues the
receipt.

### `POST /api/rentals/intent/settle`

Records return settlement economics for an active card-funded rental intent.

```bash
curl -s -X POST http://localhost:3000/api/rentals/intent/settle \
  -H 'content-type: application/json' \
  -d '{"intentId":"intent_...","ownerWallet":"OWNER_WALLET","action":"confirm_card_return"}'
```

This route does not call MoonPay payout/refund APIs yet. It records the ledger
state Gimi needs for the provider settlement and later Solana receipt:

```text
session_status=returned
settlement_status=pending_provider
receipt_status=pending_onchain
final_fee / owner_payout / platform_fee / renter_refund
```

### `POST /api/solana-pay/card-receipt`

Builds the owner-signed Solana memo transaction for a returned card-funded
rental. This is the non-crypto payment path's receipt rail: MoonPay/card handles
authorization and provider settlement, while Solana records the finalized rental
outcome.

```bash
curl -s -X POST http://localhost:3000/api/solana-pay/card-receipt \
  -H 'content-type: application/json' \
  -d '{"intentId":"intent_...","ownerWallet":"OWNER_WALLET"}'
```

The route requires `payment_status=confirmed`, `session_status=returned`, and a
matching owner wallet. It returns `transaction` plus `transactionMetadata` for
Privy wallet signing.

### `POST /api/rentals/intent/receipt`

Syncs a signed card receipt transaction back into Gimi after the owner wallet
sends it on devnet.

```bash
curl -s -X POST http://localhost:3000/api/rentals/intent/receipt \
  -H 'content-type: application/json' \
  -d '{"intentId":"intent_...","ownerWallet":"OWNER_WALLET","receiptSignature":"CONFIRMED_DEVNET_SIGNATURE"}'
```

The server verifies the devnet signature, checks that the owner is a required
transaction signer and that the exact rental settlement memo is present, writes a durable `rental_receipts` row with
`payment_mint=USD_CARD`, and marks the intent `receipt_status=issued`.

### `POST /api/payments/moonpay/checkout`

Creates or resolves a MoonPay Commerce checkout for an existing card rental
intent.

```bash
curl -s -X POST http://localhost:3000/api/payments/moonpay/checkout \
  -H 'content-type: application/json' \
  -d '{"intentId":"intent_..."}'
```

The route stores `provider_payment_id` on the intent and returns a checkout URL
when MoonPay provides one. If only `MOONPAY_COMMERCE_CHECKOUT_URL` is configured,
Gimi appends the rental intent id and amount as query parameters.

### MoonPay checkout smoke

Use this before a demo or production handoff to confirm the target app can create
a card checkout. It creates a rental intent and checkout link, but does not
complete payment.

```bash
SMOKE_BASE_URL=https://YOUR_VERCEL_URL npm run smoke:moonpay
```

For local testing, run the app with either real MoonPay Commerce credentials or
`MOONPAY_COMMERCE_CHECKOUT_URL` as a hosted-link stub:

```bash
MOONPAY_COMMERCE_CHECKOUT_URL=https://commerce.moonpay.example/checkout npm run dev
npm run smoke:moonpay
```

### `POST /api/payments/moonpay/webhook`

Receives MoonPay payment updates and syncs `rental_intents`:

```text
paid/completed/succeeded -> payment_status=confirmed, escrow_status=provider_captured, session_status=reserved
authorized -> payment_status=confirmed, escrow_status=provider_authorized, session_status=reserved
failed/canceled/expired -> payment_status=failed/expired, escrow_status=not_funded, session_status=cancelled
```

When `MOONPAY_COMMERCE_WEBHOOK_SECRET` is set, the webhook accepts either a
Bearer secret, MoonPay's timestamped HMAC-SHA256 header
(`Moonpay-Signature-V2` / `X-Moonpay-Signature-V2` with `t=...,s=...`), or an
`X-Signature` HMAC header. The webhook never moves funds; it only syncs provider
state into the rental intent ledger.

For Solana wallet checkout, before returning a transaction, the route checks
the item PDA, demo USDC mint, renter token account, and renter escrow balance.
If the renter cannot pay the buyout-cap escrow, it returns `409` with
`preflight.problems`.

This endpoint prepares the funding transaction only. It locks the buyout cap
into escrow and starts the metered session; it does not pay the host every hour.
The active-rental UI shows accrued rent inside escrow, and final payout happens
through `confirm_return` or `auto_buyout`.

Example request:

```bash
curl -s -X POST http://localhost:3000/api/solana-pay/start-rental \
  -H 'content-type: application/json' \
  -d '{"itemId":"mic_11","renterWallet":"5pNLovuXAbyKM8UGDKZg9Qqe85Sqt1kMPNaippombvwC","hours":2}'
```

Response includes:

- `rentProof.programId`
- `rentProof.accounts.config`
- `rentProof.accounts.item`
- `rentProof.accounts.session`
- `rentProof.accounts.rentalToken`
- `rentProof.accounts.escrowTokenAccount`
- `instructionArgs.startRental`
- `transaction`
- `transactionMetadata.requiredSigner`
- `transactionMetadata.lastValidBlockHeight`

### `POST /api/rentals/start`

Persists a successful `start_rental` after the renter signs and sends the
transaction. The server checks the devnet signature, derives the item/session
PDAs from the listing, rental id, and renter wallet, verifies the on-chain
`RentalItem` is rented with the expected active session, verifies the
`RentalSession` account is active, saves the session, and updates the listing
status to `rented`. After that, `GET /api/listings` no longer returns the item
as available.

Example request:

```bash
curl -s -X POST http://localhost:3000/api/rentals/start \
  -H 'content-type: application/json' \
  -d '{"itemId":"item_id_from_listing","renterWallet":"5pNLovuXAbyKM8UGDKZg9Qqe85Sqt1kMPNaippombvwC","rentalId":"draft_item_id_from_listing","startRentalSignature":"CONFIRMED_DEVNET_SIGNATURE"}'
```

Response includes:

- `rentalSession.sessionPda`
- `rentalSession.rentalTokenPda`
- `listing.status`
- `rentProof.accounts`
- `explorerUrl`

### `POST /api/solana-pay/request-return`

Returns an unsigned serialized devnet `request_return` transaction for the renter wallet to sign. This records the renter's on-chain return-request timestamp before owner confirmation, so the final rental fee is not controlled only by the owner's confirmation time.

Example request:

```bash
curl -s -X POST http://localhost:3000/api/solana-pay/request-return \
  -H 'content-type: application/json' \
  -d '{"itemId":"mic_11","renterWallet":"5pNLovuXAbyKM8UGDKZg9Qqe85Sqt1kMPNaippombvwC","rentalId":"draft_mic_11"}'
```

### `POST /api/solana-pay/confirm-return`

Returns an unsigned serialized devnet `confirm_return` transaction for the owner wallet to sign. It splits accrued rent from escrow into owner payout and platform fee, refunds the renter remainder, closes escrow/rental-token state, and emits the return receipt event.
The route verifies that the item/session PDAs exist before returning a
transaction. The settlement transaction idempotently creates missing renter,
owner, and platform fee token accounts before escrow settlement.

Example request:

```bash
curl -s -X POST http://localhost:3000/api/solana-pay/confirm-return \
  -H 'content-type: application/json' \
  -d '{"itemId":"mic_11","renterWallet":"5pNLovuXAbyKM8UGDKZg9Qqe85Sqt1kMPNaippombvwC","rentalId":"draft_mic_11"}'
```

### `POST /api/solana-pay/auto-buyout`

Returns an unsigned serialized devnet `auto_buyout` transaction for a keeper wallet to sign after due time plus grace. It claims the buyout escrow into owner/platform destination accounts, closes rental-token state, marks the item bought out, and emits the buyout receipt event.
The route uses the same settlement preflight and idempotent destination-token
account setup as `confirm_return`.

Example request:

```bash
curl -s -X POST http://localhost:3000/api/solana-pay/auto-buyout \
  -H 'content-type: application/json' \
  -d '{"itemId":"mic_11","renterWallet":"5pNLovuXAbyKM8UGDKZg9Qqe85Sqt1kMPNaippombvwC","rentalId":"draft_mic_11"}'
```

### `POST /api/rentals/settle`

Persists a successful `confirm_return` or `auto_buyout` after the owner signs
and sends the settlement transaction. The server checks the devnet signature,
re-derives the same PDAs, verifies the on-chain `RentalItem` and
`RentalSession` are in the expected settled state, updates the listing status,
updates the rental session settlement fields, and writes a durable receipt row.

For `kind: "return"`, the listing becomes `available` again and the receipt
outcome is `returned_ok`. For `kind: "buyout"`, the listing becomes `buyout`
and the receipt outcome is `auto_buyout`.

Example request:

```bash
curl -s -X POST http://localhost:3000/api/rentals/settle \
  -H 'content-type: application/json' \
  -d '{"kind":"return","itemId":"item_id_from_listing","renterWallet":"5pNLovuXAbyKM8UGDKZg9Qqe85Sqt1kMPNaippombvwC","rentalId":"draft_item_id_from_listing","settlementSignature":"CONFIRMED_DEVNET_SIGNATURE"}'
```

Response includes:

- `rentalSession.status`
- `rentalSession.finalFee`
- `rentalSession.ownerPayout`
- `rentalSession.platformFee`
- `rentalSession.renterRefund`
- `receipt.outcome`
- `receipt.settlementSignature`
- `listing.status`
- `explorerUrl`

### `GET /api/rentals/history`

Returns active rentals plus recent settled receipt rows for the user-visible
profile/history page. Active rentals include item pricing inputs so the client
can show escrow locked, rent accrued so far, and estimated refund if returned now.
Each receipt is enriched with item display data when the listing or demo item
can be found, plus a Solana explorer URL for the settlement transaction.

Optional filters:

- `wallet`: matches either owner or renter wallet.
- `rentalId`: returns one rental id when present.
- `limit`: defaults to 20 and caps at 50.

Example request:

```bash
curl -s 'http://localhost:3000/api/rentals/history?limit=10'
```

Response includes:

- `activeRentals[].amounts.escrow`
- `activeRentals[].item.ratePerHour`
- `activeRentals[].item.minimumFee`
- `activeRentals[].item.buyoutCap`
- `receipts[].rentalId`
- `receipts[].item.name`
- `receipts[].outcome`
- `receipts[].settlementSignature`
- `receipts[].explorerUrl`
- `receipts[].grossFee`
- `receipts[].platformFee`
- `receipts[].ownerPayout`
- `receipts[].renterRefund`
- `receipts[].ownerWalletShort`
- `receipts[].renterWalletShort`

### `POST /api/lifi/quote`

Returns a LI.FI route for funding the Solana escrow amount. With real wallet addresses, it calls LI.FI REST and returns the LI.FI `transactionRequest`.

Example live quote:

```bash
curl -s -X POST http://localhost:3000/api/lifi/quote \
  -H 'content-type: application/json' \
  -d '{"amount":30,"fromAddress":"0x000000000000000000000000000000000000dEaD","toAddress":"5pNLovuXAbyKM8UGDKZg9Qqe85Sqt1kMPNaippombvwC","requireReal":true}'
```

Without valid wallet addresses, the endpoint returns a demo route so the chat UI can still run locally.

### `GET /api/elevenlabs/tools`

Returns the ElevenLabs server-tool registration metadata for the Gimi agent.

### `POST /api/elevenlabs/tools`

Handles tool calls:

- `rentproof.find_offers`
- `rentproof.draft_terms`
- `rentproof.quote_funding`
- `rentproof.create_rental_request`
- `rentproof.prepare_return_request`
- `rentproof.prepare_return_confirmation`
- `rentproof.prepare_auto_buyout`

### `GET /api/base-plugin/gimi`

Returns the Gimi Base MCP plugin manifest and endpoint map.

### `GET /api/base-plugin/gimi/openapi.json`

Returns a machine-readable OpenAPI 3.1 description for Base plugin setup.

```bash
curl -s "http://localhost:3000/api/base-plugin/gimi/openapi.json"
```

### `GET /api/base-plugin/gimi/inventory`

Returns rentable community inventory for an agent query.

```bash
curl -s "http://localhost:3000/api/base-plugin/gimi/inventory?query=wireless%20mic"
```

### `GET /api/base-plugin/gimi/quote`

Quotes rent, deposit, platform-fee estimate, and refund model for Base USDC funding.

```bash
curl -s "http://localhost:3000/api/base-plugin/gimi/quote?itemId=mic_11&hours=2"
```

### `GET /api/base-plugin/gimi/prepare-deposit`

Returns ERC-20 USDC `transfer` calldata that Base MCP can submit through `send_calls` after user approval. Gimi does not sign or broadcast this call.

```bash
curl -s "http://localhost:3000/api/base-plugin/gimi/prepare-deposit?itemId=mic_11&hours=2&from=0x000000000000000000000000000000000000dEaD&escrow=0x0000000000000000000000000000000000000001"
```

### `POST /api/base-plugin/gimi/payment-confirmed`

Records a confirmed Base MCP payment as a `rental_intent` with `provider:
"base_mcp"`. The rental appears in profile/history, the owner can mark handoff
and confirm return, and Base-funded returns write an off-chain receipt tied to
the Base transaction hash. Set `BASE_MCP_CONFIRMATION_SECRET` in production and
call this endpoint with `Authorization: Bearer <secret>` from a trusted
agent/backend; without it, confirmation is caller-attested demo mode.

```bash
curl -s -X POST http://localhost:3000/api/base-plugin/gimi/payment-confirmed \
  -H 'content-type: application/json' \
  -d '{"itemId":"mic_11","hours":2,"renterWallet":"0x000000000000000000000000000000000000dEaD","txHash":"0x1111111111111111111111111111111111111111111111111111111111111111","chain":"base-sepolia"}'
```

### `GET /api/base-plugin/gimi/status`

Returns Base MCP-funded rental intents and receipts for an EVM renter wallet.

```bash
curl -s "http://localhost:3000/api/base-plugin/gimi/status?wallet=0x000000000000000000000000000000000000dEaD"
```

See [docs/base-mcp-plugin.md](docs/base-mcp-plugin.md) for the plugin prompt and Base MCP handoff shape.
See [docs/base-mcp-production.md](docs/base-mcp-production.md) for the production setup guide.

### `POST /api/rent`

Starts the local demo rental state and returns the same Gimi PDA metadata used by the agent UI.

### `GET /idl/rental_session.json`

Serves the generated Anchor IDL.

## Current Boundary

This repo now has a deployed devnet Anchor settlement program, a product-ready demo surface, owner listing prepare/sign/publish flow, item photo upload pipeline, owner inventory pause/re-enable management, notification feed, production env readiness checks, MoonPay checkout smoke tooling, rental start status sync, return/auto-buyout settlement sync, card-funded return ledger and Solana memo receipt issuance, durable receipt persistence, a renter/owner-visible receipt history surface, live LI.FI quote support, ElevenLabs server-tool endpoints, Base MCP read/prepare/confirm endpoints, unsigned serialized Solana transaction generation, and wallet-side signing/sending for prepared transactions.

- Program id: `AVL316tYxrg8MhEeWtaxbwdShMWybzRAH1zNQWvX355K`.
- Published listings, rental intents, rental sessions, and rental receipts use Supabase when configured. Without Supabase env vars, the app falls back to ephemeral file storage.
- Privy wallet login requires `NEXT_PUBLIC_PRIVY_APP_ID`.
- LI.FI live quotes require valid source and destination wallet addresses; local demo mode falls back when those are missing.
- ElevenLabs is server-tool ready, but the hosted ElevenLabs agent still needs to be configured with this endpoint and `ELEVENLABS_API_KEY`.
- MCP, Base MCP, and ElevenLabs tools never sign or move funds; they expose read/prepare tools only.
- `npm run audit:runtime` blocks new production dependency advisories. The remaining upstream residuals are documented in [docs/dependency-security.md](docs/dependency-security.md).

## Next Steps

1. Run the Supabase migrations and add `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` to Vercel.
2. Add `NEXT_PUBLIC_PRIVY_APP_ID` to Vercel production and local `.env.local`.
3. Configure MoonPay Commerce checkout/webhook env vars before enabling non-crypto payments in production.
4. Run the devnet E2E with funded owner/renter wallets; it now covers owner listing, start rental, return settlement, auto-buyout settlement, listing status sync, card memo receipt issuance, and receipt persistence.
5. Register `/api/elevenlabs/tools` in the ElevenLabs agent console.
