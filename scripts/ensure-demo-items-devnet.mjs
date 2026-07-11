import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { COMMUNITY_ITEMS, DEMO_OWNER_WALLET } from "../src/lib/store.ts";
import {
  DEMO_USDC_MINT,
  RENTAL_ITEM_STATUS_AVAILABLE,
  SOLANA_RPC_URL,
  buildInitializeItemTransaction,
  bytes32Hex,
  decodeRentalItemAccount,
} from "../src/lib/rentproofProgram.ts";

const checkOnly = process.argv.includes("--check");
const keypairPath = process.env.PAYER_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`;
const connection = new Connection(SOLANA_RPC_URL, "confirmed");
const items = COMMUNITY_ITEMS.filter((item) => item.status === "available");
const owner = checkOnly
  ? null
  : Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8"))));

if (owner && owner.publicKey.toBase58() !== DEMO_OWNER_WALLET) {
  throw new Error(`Demo owner ${DEMO_OWNER_WALLET} does not match ${keypairPath}`);
}

let initialized = 0;
for (const item of items) {
  const prepared = await buildInitializeItemTransaction({
    ownerWallet: DEMO_OWNER_WALLET,
    itemId: item.id,
    metadataHash: bytes32Hex(item.id),
    ratePerHour: item.ratePerHour,
    minimumFee: item.minimumFee,
    buyoutCap: item.buyoutCap,
    autoBuyoutGraceSeconds: 60 * 60,
    paymentMint: DEMO_USDC_MINT,
  });
  const accountInfo = await connection.getAccountInfo(new PublicKey(prepared.itemPda), "confirmed");

  if (accountInfo) {
    const account = decodeRentalItemAccount(accountInfo.data);
    if (account.status !== RENTAL_ITEM_STATUS_AVAILABLE) {
      throw new Error(`${item.id} exists but is not available (status ${account.status})`);
    }
    console.log(`ok ${item.id} ${prepared.itemPda}`);
    continue;
  }
  if (checkOnly) throw new Error(`${item.id} Item PDA is missing: ${prepared.itemPda}`);
  if (!owner) throw new Error("Demo owner keypair is required to initialize missing items");

  const transaction = Transaction.from(Buffer.from(prepared.transactionBase64, "base64"));
  const signature = await sendAndConfirmTransaction(connection, transaction, [owner], {
    commitment: "confirmed",
  });
  initialized += 1;
  console.log(`initialized ${item.id} ${signature}`);
}

console.log(`demo_items=${items.length} initialized=${initialized} cluster=devnet`);
