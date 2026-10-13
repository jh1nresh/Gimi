# Base MCP Production Setup

This guide turns the current Gimi Base MCP endpoints into a production-ready agent integration path.

Base MCP should handle wallet approval and transaction execution. Gimi should handle inventory, quote, reservation state, owner handoff, return settlement, and receipt history.

## Production Flow

```text
User asks for an item
-> Base MCP calls Gimi inventory and quote endpoints
-> Gimi prepares Base USDC deposit calldata
-> User approves the call through Base MCP send_calls
-> Trusted backend/agent calls payment-confirmed with the Base tx hash
-> Gimi creates rental_intent provider=base_mcp
-> Owner marks handed off
-> Owner confirms return
-> Gimi records payout/refund amounts and a Base-linked receipt
```

## Deploy

Deploy the latest `main` branch to Vercel, then set these environment variables:

```bash
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY

BASE_MCP_CHAIN=base-sepolia
BASE_RENTAL_ESCROW_ADDRESS=0xYOUR_ESCROW_OR_TREASURY
BASE_MCP_CONFIRMATION_SECRET=GENERATE_A_LONG_RANDOM_SECRET
BASE_USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
BASE_SEPOLIA_USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
```

Run all Supabase migrations through:

```text
supabase/migrations/009_add_base_mcp_rental_intents.sql
```

`BASE_MCP_CONFIRMATION_SECRET` is required for production and Vercel previews. Without it, `payment-confirmed` returns HTTP 503 before reading or writing rentals. Caller-attested demo mode is restricted to local non-production runs.

## Plugin URLs

Replace `https://YOUR_GIMI_DOMAIN` with the Vercel production URL:

```text
Manifest:
https://YOUR_GIMI_DOMAIN/api/base-plugin/gimi

OpenAPI:
https://YOUR_GIMI_DOMAIN/api/base-plugin/gimi/openapi.json

Inventory:
https://YOUR_GIMI_DOMAIN/api/base-plugin/gimi/inventory?query=wireless%20mic

Quote:
https://YOUR_GIMI_DOMAIN/api/base-plugin/gimi/quote?itemId=mic_11&hours=2

Prepare deposit:
https://YOUR_GIMI_DOMAIN/api/base-plugin/gimi/prepare-deposit?itemId=mic_11&hours=2&from=0xUSER&escrow=0xESCROW

Payment confirmed:
https://YOUR_GIMI_DOMAIN/api/base-plugin/gimi/payment-confirmed

Status:
https://YOUR_GIMI_DOMAIN/api/base-plugin/gimi/status?wallet=0xUSER
```

## Base MCP Prompt

```text
You are the Gimi rental agent for Base.

Use Gimi to help users rent nearby community inventory.

Flow:
1. Search inventory with GET /api/base-plugin/gimi/inventory.
2. Quote rent and deposit with GET /api/base-plugin/gimi/quote.
3. Prepare Base USDC calldata with GET /api/base-plugin/gimi/prepare-deposit.
4. Ask the user to approve the returned call with Base MCP send_calls.
5. After Base MCP returns a confirmed tx hash, call POST /api/base-plugin/gimi/payment-confirmed from a trusted backend/action using Authorization: Bearer <secret>.
6. Tell the user the owner must mark physical handoff and confirm return.
7. Use GET /api/base-plugin/gimi/status to show active rentals and receipt history.

Never sign, broadcast, or custody keys yourself. Always require user approval for payment calls.
```

## Confirm Payment

Use this only after Base MCP returns a confirmed transaction hash:

```bash
curl -s -X POST https://YOUR_GIMI_DOMAIN/api/base-plugin/gimi/payment-confirmed \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $BASE_MCP_CONFIRMATION_SECRET" \
  -d '{
    "itemId": "mic_11",
    "hours": 2,
    "renterWallet": "0x000000000000000000000000000000000000dEaD",
    "txHash": "0x1111111111111111111111111111111111111111111111111111111111111111",
    "chain": "base-sepolia"
  }'
```

Expected response:

```json
{
  "intent": {
    "paymentMethod": "base_mcp",
    "paymentStatus": "confirmed",
    "escrowStatus": "provider_captured",
    "sessionStatus": "reserved",
    "provider": "base_mcp"
  },
  "verificationMode": "bearer_authorized_caller_attested",
  "nextAction": "owner_mark_handed_off"
}
```

## Smoke Test

Use isolated wallets on Base Sepolia first:

```bash
BASE=https://YOUR_GIMI_DOMAIN
USER=0x000000000000000000000000000000000000dEaD
TX=0x1111111111111111111111111111111111111111111111111111111111111111

curl -s "$BASE/api/base-plugin/gimi/openapi.json"
curl -s "$BASE/api/base-plugin/gimi/inventory?query=wireless%20mic"
curl -s "$BASE/api/base-plugin/gimi/quote?itemId=mic_11&hours=2"
curl -s "$BASE/api/base-plugin/gimi/prepare-deposit?itemId=mic_11&hours=2&from=$USER&escrow=$BASE_RENTAL_ESCROW_ADDRESS"
curl -s -X POST "$BASE/api/base-plugin/gimi/payment-confirmed" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $BASE_MCP_CONFIRMATION_SECRET" \
  -d "{\"itemId\":\"mic_11\",\"hours\":2,\"renterWallet\":\"$USER\",\"txHash\":\"$TX\",\"chain\":\"base-sepolia\"}"
curl -s "$BASE/api/base-plugin/gimi/status?wallet=$USER"
```

## Current Boundary

This is not a trustless Base escrow contract yet. Production can use a trusted confirmation caller with `BASE_MCP_CONFIRMATION_SECRET`, but the durable long-term version should verify Base transaction receipts server-side or replace the treasury transfer with a Base escrow contract.
