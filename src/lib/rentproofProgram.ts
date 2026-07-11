import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

export const RENTAL_SESSION_PROGRAM_ID = new PublicKey("AVL316tYxrg8MhEeWtaxbwdShMWybzRAH1zNQWvX355K");
export const DEMO_OWNER_WALLET = new PublicKey("3z6edmobZbGBQP1pxfYi3XuxqEFeZn1rZfGBegtJ2GAh");
export const DEMO_RENTER_WALLET = new PublicKey("5pNLovuXAbyKM8UGDKZg9Qqe85Sqt1kMPNaippombvwC");
export const DEMO_FEE_AUTHORITY = new PublicKey("AWesFzR3x97q5QWk6MBxLU8kRGZcuobtKuoABtMiHWH1");
export const DEMO_USDC_MINT = new PublicKey("FGzrpZ3DnvoeQj2au9g4cMoawrvoyRdgn51yXDtHqQzp");
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

export const PLATFORM_FEE_BPS = 500;
export const USDC_DECIMALS = 6;
export const AUTO_BUYOUT_GRACE_SECONDS = 60 * 60;
export const SOLANA_CLUSTER = "devnet";
export const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
export const RENTAL_ITEM_STATUS_AVAILABLE = 0;
export const RENTAL_ITEM_STATUS_RENTED = 1;
export const RENTAL_ITEM_STATUS_BUYOUT = 2;
export const RENTAL_SESSION_STATUS_ACTIVE = 0;
export const RENTAL_SESSION_STATUS_RETURNED = 1;
export const RENTAL_SESSION_STATUS_BUYOUT = 2;

export function bytes32Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function bytes32Array(value: string) {
  return Array.from(createHash("sha256").update(value).digest());
}

export function bytes32Buffer(value: string) {
  return Buffer.from(bytes32Array(value));
}

export function bytes32HexToBuffer(value: string) {
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error("Expected 32-byte hex string");
  }
  return Buffer.from(value, "hex");
}

export function usdcBaseUnits(amount: number) {
  return Math.round(amount * 10 ** USDC_DECIMALS);
}

export function ratePerSecondBaseUnits(ratePerHour: number) {
  return Math.max(1, Math.ceil(usdcBaseUnits(ratePerHour) / 3600));
}

export function publicKeyOrFallback(value: unknown, fallback: PublicKey) {
  if (typeof value !== "string") return fallback;
  try {
    return new PublicKey(value);
  } catch {
    return fallback;
  }
}

export function publicKeyFromInput(value: string | PublicKey, fieldName = "public key") {
  if (value instanceof PublicKey) return value;
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`Invalid ${fieldName}`);
  }
}

export function deriveRentProofAccounts(input: {
  itemId: string;
  ownerWallet?: unknown;
  renterWallet?: unknown;
  rentalId?: string;
  paymentMint?: PublicKey;
}) {
  const owner = publicKeyOrFallback(input.ownerWallet, DEMO_OWNER_WALLET);
  const renter = publicKeyOrFallback(input.renterWallet, DEMO_RENTER_WALLET);
  const paymentMint = input.paymentMint ?? DEMO_USDC_MINT;
  const itemIdHash = Buffer.from(bytes32Array(input.itemId));
  const rentalIdHash = Buffer.from(bytes32Array(input.rentalId ?? `${input.itemId}:${renter.toBase58()}`));

  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], RENTAL_SESSION_PROGRAM_ID);
  const [item] = PublicKey.findProgramAddressSync(
    [Buffer.from("item"), owner.toBuffer(), itemIdHash],
    RENTAL_SESSION_PROGRAM_ID
  );
  const [session] = PublicKey.findProgramAddressSync(
    [Buffer.from("session"), item.toBuffer(), rentalIdHash],
    RENTAL_SESSION_PROGRAM_ID
  );
  const [rentalToken] = PublicKey.findProgramAddressSync(
    [Buffer.from("rental_token"), session.toBuffer()],
    RENTAL_SESSION_PROGRAM_ID
  );
  const [escrowTokenAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), session.toBuffer()],
    RENTAL_SESSION_PROGRAM_ID
  );
  const [escrowAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow_authority"), session.toBuffer()],
    RENTAL_SESSION_PROGRAM_ID
  );
  const renterTokenAccount = getAssociatedTokenAddressSync(paymentMint, renter);
  const ownerTokenAccount = getAssociatedTokenAddressSync(paymentMint, owner);
  const platformFeeTokenAccount = getAssociatedTokenAddressSync(paymentMint, DEMO_FEE_AUTHORITY);

  return {
    programId: RENTAL_SESSION_PROGRAM_ID.toBase58(),
    idlPath: "/idl/rental_session.json",
    itemIdHash: bytes32Hex(input.itemId),
    rentalIdHash: Buffer.from(rentalIdHash).toString("hex"),
    accounts: {
      config: config.toBase58(),
      item: item.toBase58(),
      session: session.toBase58(),
      rentalToken: rentalToken.toBase58(),
      escrowTokenAccount: escrowTokenAccount.toBase58(),
      escrowAuthority: escrowAuthority.toBase58(),
      renterTokenAccount: renterTokenAccount.toBase58(),
      ownerTokenAccount: ownerTokenAccount.toBase58(),
      platformFeeTokenAccount: platformFeeTokenAccount.toBase58(),
      owner: owner.toBase58(),
      renter: renter.toBase58(),
      feeAuthority: DEMO_FEE_AUTHORITY.toBase58(),
      paymentMint: paymentMint.toBase58(),
    },
  };
}

export function anchorInstructionDiscriminator(name: string) {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

export function startRentalInstructionData(input: {
  rentalIdHash: string;
  rentalSeconds: number;
}) {
  const data = Buffer.alloc(8 + 32 + 8);
  anchorInstructionDiscriminator("start_rental").copy(data, 0);
  Buffer.from(input.rentalIdHash, "hex").copy(data, 8);
  data.writeBigInt64LE(BigInt(input.rentalSeconds), 40);
  return data;
}

export function settleRentalInstructionData(kind: "confirm_return" | "auto_buyout") {
  return anchorInstructionDiscriminator(kind);
}

export function requestReturnInstructionData() {
  return anchorInstructionDiscriminator("request_return");
}

export function initializeItemInstructionData(input: {
  itemIdHash: Buffer;
  metadataHash: Buffer;
  ratePerSecond: number;
  minimumFee: number;
  buyoutCap: number;
  autoBuyoutGraceSeconds: number;
}) {
  if (input.itemIdHash.byteLength !== 32 || input.metadataHash.byteLength !== 32) {
    throw new Error("initialize_item hashes must be 32 bytes");
  }

  const data = Buffer.alloc(8 + 32 + 32 + 8 + 8 + 8 + 8);
  anchorInstructionDiscriminator("initialize_item").copy(data, 0);
  input.itemIdHash.copy(data, 8);
  input.metadataHash.copy(data, 40);
  data.writeBigUInt64LE(BigInt(input.ratePerSecond), 72);
  data.writeBigUInt64LE(BigInt(input.minimumFee), 80);
  data.writeBigUInt64LE(BigInt(input.buyoutCap), 88);
  data.writeBigInt64LE(BigInt(input.autoBuyoutGraceSeconds), 96);
  return data;
}

export function deriveItemPda(owner: PublicKey, itemIdHash: Buffer) {
  return PublicKey.findProgramAddressSync([Buffer.from("item"), owner.toBuffer(), itemIdHash], RENTAL_SESSION_PROGRAM_ID)[0];
}

export async function buildInitializeItemTransaction(input: {
  ownerWallet: string | PublicKey;
  itemId: string;
  metadataHash: string;
  ratePerHour: number;
  minimumFee: number;
  buyoutCap: number;
  autoBuyoutGraceSeconds: number;
  paymentMint?: PublicKey;
}) {
  const owner = publicKeyFromInput(input.ownerWallet, "ownerWallet");
  const paymentMint = input.paymentMint ?? DEMO_USDC_MINT;
  const itemIdHash = bytes32Buffer(input.itemId);
  const metadataHash = bytes32HexToBuffer(input.metadataHash);
  const item = deriveItemPda(owner, itemIdHash);
  const ratePerSecond = ratePerSecondBaseUnits(input.ratePerHour);
  const minimumFee = usdcBaseUnits(input.minimumFee);
  const buyoutCap = usdcBaseUnits(input.buyoutCap);
  const connection = new Connection(SOLANA_RPC_URL, "confirmed");
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");

  const instruction = new TransactionInstruction({
    programId: RENTAL_SESSION_PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: item, isSigner: false, isWritable: true },
      { pubkey: paymentMint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: initializeItemInstructionData({
      itemIdHash,
      metadataHash,
      ratePerSecond,
      minimumFee,
      buyoutCap,
      autoBuyoutGraceSeconds: input.autoBuyoutGraceSeconds,
    }),
  });

  const transaction = new Transaction({
    feePayer: owner,
    recentBlockhash: blockhash,
  }).add(instruction);

  return {
    transactionBase64: transaction
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64"),
    itemPda: item.toBase58(),
    itemIdHash: itemIdHash.toString("hex"),
    metadataHash: metadataHash.toString("hex"),
    paymentMint: paymentMint.toBase58(),
    requiredSigner: owner.toBase58(),
    feePayer: owner.toBase58(),
    blockhash,
    lastValidBlockHeight,
    cluster: SOLANA_CLUSTER,
    rpcUrl: SOLANA_RPC_URL,
  };
}

export function rentalItemAccountDiscriminator() {
  return createHash("sha256").update("account:RentalItem").digest().subarray(0, 8);
}

export function decodeRentalItemAccount(data: Uint8Array) {
  const buffer = Buffer.from(data);
  if (buffer.byteLength < 8 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 32 + 1 + 1) {
    throw new Error("RentalItem account data is too short");
  }

  const discriminator = rentalItemAccountDiscriminator();
  if (!buffer.subarray(0, 8).equals(discriminator)) {
    throw new Error("Account is not a RentalItem");
  }

  return {
    owner: new PublicKey(buffer.subarray(8, 40)).toBase58(),
    paymentMint: new PublicKey(buffer.subarray(40, 72)).toBase58(),
    itemIdHash: buffer.subarray(72, 104).toString("hex"),
    metadataHash: buffer.subarray(104, 136).toString("hex"),
    ratePerSecond: buffer.readBigUInt64LE(136),
    minimumFee: buffer.readBigUInt64LE(144),
    buyoutCap: buffer.readBigUInt64LE(152),
    autoBuyoutGraceSeconds: buffer.readBigInt64LE(160),
    activeSession: new PublicKey(buffer.subarray(168, 200)).toBase58(),
    status: buffer.readUInt8(200),
    bump: buffer.readUInt8(201),
  };
}

export function rentalSessionAccountDiscriminator() {
  return createHash("sha256").update("account:RentalSession").digest().subarray(0, 8);
}

export function decodeRentalSessionAccount(data: Uint8Array) {
  const buffer = Buffer.from(data);
  if (buffer.byteLength < 8 + 32 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 1 + 1 + 1 + 1) {
    throw new Error("RentalSession account data is too short");
  }

  const discriminator = rentalSessionAccountDiscriminator();
  if (!buffer.subarray(0, 8).equals(discriminator)) {
    throw new Error("Account is not a RentalSession");
  }

  return {
    item: new PublicKey(buffer.subarray(8, 40)).toBase58(),
    renter: new PublicKey(buffer.subarray(40, 72)).toBase58(),
    owner: new PublicKey(buffer.subarray(72, 104)).toBase58(),
    paymentMint: new PublicKey(buffer.subarray(104, 136)).toBase58(),
    rentalIdHash: buffer.subarray(136, 168).toString("hex"),
    startTs: buffer.readBigInt64LE(168),
    dueTs: buffer.readBigInt64LE(176),
    returnedTs: buffer.readBigInt64LE(184),
    escrowAmount: buffer.readBigUInt64LE(192),
    expectedFeeAtStart: buffer.readBigUInt64LE(200),
    finalFee: buffer.readBigUInt64LE(208),
    ownerPayout: buffer.readBigUInt64LE(216),
    platformFee: buffer.readBigUInt64LE(224),
    renterRefund: buffer.readBigUInt64LE(232),
    returnRequestedTs: buffer.readBigInt64LE(240),
    status: buffer.readUInt8(248),
    bump: buffer.readUInt8(249),
    escrowBump: buffer.readUInt8(250),
    rentalTokenBump: buffer.readUInt8(251),
  };
}

export async function assertConfirmedSignature(connection: Connection, signature: string) {
  const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
  const status = value[0];

  if (!status) throw new Error("Transaction signature was not found on devnet");
  if (status.err) throw new Error("Transaction failed on-chain");
  if (status.confirmationStatus !== "confirmed" && status.confirmationStatus !== "finalized" && status.confirmations !== null) {
    throw new Error("Transaction is not confirmed yet");
  }
}

export interface RentProofPreflight {
  ok: boolean;
  cluster: string;
  rpcUrl: string;
  problems: string[];
  accounts: {
    item?: string;
    session?: string;
    renterTokenAccount: string;
    ownerTokenAccount: string;
    platformFeeTokenAccount: string;
    paymentMint: string;
  };
  tokenAccounts: {
    renter: TokenAccountCheck;
    owner: TokenAccountCheck;
    platformFee: TokenAccountCheck;
  };
  requiredEscrowAmount?: number;
}

interface TokenAccountCheck {
  address: string;
  exists: boolean;
  owner?: string;
  mint?: string;
  amount?: string;
  uiAmount?: number | null;
}

function loadOptionalKeypair(path: string) {
  if (!existsSync(path)) return null;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

async function getTokenAccountCheck(connection: Connection, address: string): Promise<TokenAccountCheck> {
  const pubkey = new PublicKey(address);
  const accountInfo = await connection.getAccountInfo(pubkey, "confirmed");
  if (!accountInfo) return { address, exists: false };

  const balance = await connection.getTokenAccountBalance(pubkey, "confirmed");
  return {
    address,
    exists: true,
    owner: accountInfo.owner.toBase58(),
    amount: balance.value.amount,
    uiAmount: balance.value.uiAmount,
  };
}

export async function ensureDemoRenterUsdc(input: {
  renterWallet: string | PublicKey;
  minimumUiAmount: number;
}) {
  if (process.env.GIMI_ENABLE_DEMO_USDC_FAUCET !== "true") {
    return {
      ok: false,
      changed: false,
      skipped: true,
      reason: "Demo USDC faucet is disabled. Set GIMI_ENABLE_DEMO_USDC_FAUCET=true for local demos.",
    };
  }

  const renter = publicKeyFromInput(input.renterWallet, "renterWallet");
  const connection = new Connection(SOLANA_RPC_URL, "confirmed");
  const renterTokenAccount = getAssociatedTokenAddressSync(DEMO_USDC_MINT, renter);
  const requiredAmount = BigInt(usdcBaseUnits(input.minimumUiAmount));
  const targetAmount = BigInt(usdcBaseUnits(Math.max(input.minimumUiAmount, 1000)));
  const tokenAccount = await getTokenAccountCheck(connection, renterTokenAccount.toBase58());
  const currentAmount = BigInt(tokenAccount.amount ?? "0");

  if (tokenAccount.exists && currentAmount >= requiredAmount) {
    return {
      ok: true,
      changed: false,
      renterTokenAccount: renterTokenAccount.toBase58(),
      amount: tokenAccount.amount,
      uiAmount: tokenAccount.uiAmount,
    };
  }

  const payerPath = process.env.PAYER_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`;
  const payer = loadOptionalKeypair(payerPath);
  if (!payer) {
    return {
      ok: false,
      changed: false,
      renterTokenAccount: renterTokenAccount.toBase58(),
      reason: `Demo USDC mint authority keypair not found at ${payerPath}`,
    };
  }

  const mintAmount = targetAmount > currentAmount ? targetAmount - currentAmount : requiredAmount;
  const transaction = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      renterTokenAccount,
      renter,
      DEMO_USDC_MINT
    ),
    createMintToInstruction(DEMO_USDC_MINT, renterTokenAccount, payer.publicKey, mintAmount)
  );
  let signature: string;
  try {
    signature = await sendAndConfirmTransaction(connection, transaction, [payer], {
      commitment: "confirmed",
    });
  } catch (error) {
    return {
      ok: false,
      changed: false,
      renterTokenAccount: renterTokenAccount.toBase58(),
      reason: error instanceof Error ? error.message : "Could not mint demo USDC to renter wallet",
    };
  }
  const refreshed = await getTokenAccountCheck(connection, renterTokenAccount.toBase58());

  return {
    ok: true,
    changed: true,
    signature,
    renterTokenAccount: renterTokenAccount.toBase58(),
    amount: refreshed.amount,
    uiAmount: refreshed.uiAmount,
  };
}

async function getOwnedAccount(connection: Connection, address: string, expectedOwner: PublicKey) {
  const accountInfo = await connection.getAccountInfo(new PublicKey(address), "confirmed");
  if (!accountInfo) return { exists: false, owned: false, accountInfo: null };
  return { exists: true, owned: accountInfo.owner.equals(expectedOwner), accountInfo };
}

export async function preflightStartRental(input: {
  itemId: string;
  ownerWallet?: unknown;
  renterWallet?: unknown;
  rentalId: string;
  buyoutCap: number;
}) {
  const rentProof = deriveRentProofAccounts(input);
  const accounts = rentProof.accounts;
  const connection = new Connection(SOLANA_RPC_URL, "confirmed");
  const problems: string[] = [];
  const [itemCheck, renterTokenAccount, ownerTokenAccount, platformFeeTokenAccount, mintCheck] = await Promise.all([
    getOwnedAccount(connection, accounts.item, RENTAL_SESSION_PROGRAM_ID),
    getTokenAccountCheck(connection, accounts.renterTokenAccount),
    getTokenAccountCheck(connection, accounts.ownerTokenAccount),
    getTokenAccountCheck(connection, accounts.platformFeeTokenAccount),
    getOwnedAccount(connection, accounts.paymentMint, TOKEN_PROGRAM_ID),
  ]);
  const requiredEscrowAmount = usdcBaseUnits(input.buyoutCap);

  if (!mintCheck.exists) problems.push("Payment mint account does not exist on devnet.");
  if (mintCheck.exists && !mintCheck.owned) problems.push("Payment mint is not owned by the SPL Token program.");
  if (!itemCheck.exists) {
    problems.push("Item PDA does not exist. The owner must publish initialize_item before rental.");
  } else if (!itemCheck.owned) {
    problems.push("Item PDA is not owned by the Gimi rental program.");
  } else if (itemCheck.accountInfo) {
    try {
      const decoded = decodeRentalItemAccount(itemCheck.accountInfo.data);
      if (decoded.status !== RENTAL_ITEM_STATUS_AVAILABLE) {
        problems.push("Item is not available for rental.");
      }
      if (decoded.paymentMint !== accounts.paymentMint) {
        problems.push("Item payment mint does not match the expected demo USDC mint.");
      }
    } catch (error) {
      problems.push(error instanceof Error ? error.message : "Could not decode item PDA.");
    }
  }
  if (!renterTokenAccount.exists) {
    problems.push("Renter demo USDC token account is missing. Fund/setup the renter wallet before rental.");
  } else if (BigInt(renterTokenAccount.amount ?? "0") < BigInt(requiredEscrowAmount)) {
    problems.push(`Renter has insufficient demo USDC. Need ${input.buyoutCap} USDC escrow.`);
  }

  return {
    ok: problems.length === 0,
    cluster: SOLANA_CLUSTER,
    rpcUrl: SOLANA_RPC_URL,
    problems,
    accounts: {
      item: accounts.item,
      renterTokenAccount: accounts.renterTokenAccount,
      ownerTokenAccount: accounts.ownerTokenAccount,
      platformFeeTokenAccount: accounts.platformFeeTokenAccount,
      paymentMint: accounts.paymentMint,
    },
    tokenAccounts: {
      renter: renterTokenAccount,
      owner: ownerTokenAccount,
      platformFee: platformFeeTokenAccount,
    },
    requiredEscrowAmount,
  } satisfies RentProofPreflight;
}

export async function preflightSettleRental(input: {
  itemId: string;
  ownerWallet?: unknown;
  renterWallet?: unknown;
  rentalId: string;
}) {
  const rentProof = deriveRentProofAccounts(input);
  const accounts = rentProof.accounts;
  const connection = new Connection(SOLANA_RPC_URL, "confirmed");
  const problems: string[] = [];
  const [itemCheck, sessionCheck, renterTokenAccount, ownerTokenAccount, platformFeeTokenAccount, mintCheck] = await Promise.all([
    getOwnedAccount(connection, accounts.item, RENTAL_SESSION_PROGRAM_ID),
    getOwnedAccount(connection, accounts.session, RENTAL_SESSION_PROGRAM_ID),
    getTokenAccountCheck(connection, accounts.renterTokenAccount),
    getTokenAccountCheck(connection, accounts.ownerTokenAccount),
    getTokenAccountCheck(connection, accounts.platformFeeTokenAccount),
    getOwnedAccount(connection, accounts.paymentMint, TOKEN_PROGRAM_ID),
  ]);

  if (!mintCheck.exists) problems.push("Payment mint account does not exist on devnet.");
  if (mintCheck.exists && !mintCheck.owned) problems.push("Payment mint is not owned by the SPL Token program.");
  if (!itemCheck.exists) problems.push("Item PDA does not exist.");
  if (itemCheck.exists && !itemCheck.owned) problems.push("Item PDA is not owned by the Gimi rental program.");
  if (!sessionCheck.exists) problems.push("Rental session PDA does not exist. Start rental before settlement.");
  if (sessionCheck.exists && !sessionCheck.owned) problems.push("Rental session PDA is not owned by the Gimi rental program.");

  return {
    ok: problems.length === 0,
    cluster: SOLANA_CLUSTER,
    rpcUrl: SOLANA_RPC_URL,
    problems,
    accounts: {
      item: accounts.item,
      session: accounts.session,
      renterTokenAccount: accounts.renterTokenAccount,
      ownerTokenAccount: accounts.ownerTokenAccount,
      platformFeeTokenAccount: accounts.platformFeeTokenAccount,
      paymentMint: accounts.paymentMint,
    },
    tokenAccounts: {
      renter: renterTokenAccount,
      owner: ownerTokenAccount,
      platformFee: platformFeeTokenAccount,
    },
  } satisfies RentProofPreflight;
}

export async function preflightRequestReturn(input: {
  itemId: string;
  ownerWallet?: unknown;
  renterWallet?: unknown;
  rentalId: string;
}) {
  const rentProof = deriveRentProofAccounts(input);
  const accounts = rentProof.accounts;
  const connection = new Connection(SOLANA_RPC_URL, "confirmed");
  const problems: string[] = [];
  const [itemCheck, sessionCheck, rentalTokenCheck] = await Promise.all([
    getOwnedAccount(connection, accounts.item, RENTAL_SESSION_PROGRAM_ID),
    getOwnedAccount(connection, accounts.session, RENTAL_SESSION_PROGRAM_ID),
    getOwnedAccount(connection, accounts.rentalToken, RENTAL_SESSION_PROGRAM_ID),
  ]);

  if (!itemCheck.exists) problems.push("Item PDA does not exist.");
  if (itemCheck.exists && !itemCheck.owned) problems.push("Item PDA is not owned by the Gimi rental program.");
  if (!sessionCheck.exists) problems.push("Rental session PDA does not exist. Start rental before requesting return.");
  if (sessionCheck.exists && !sessionCheck.owned) problems.push("Rental session PDA is not owned by the Gimi rental program.");
  if (!rentalTokenCheck.exists) problems.push("Rental token PDA does not exist.");
  if (rentalTokenCheck.exists && !rentalTokenCheck.owned) {
    problems.push("Rental token PDA is not owned by the Gimi rental program.");
  }

  return {
    ok: problems.length === 0,
    cluster: SOLANA_CLUSTER,
    rpcUrl: SOLANA_RPC_URL,
    problems,
    accounts: {
      item: accounts.item,
      session: accounts.session,
      rentalToken: accounts.rentalToken,
      renterTokenAccount: accounts.renterTokenAccount,
      ownerTokenAccount: accounts.ownerTokenAccount,
      platformFeeTokenAccount: accounts.platformFeeTokenAccount,
      paymentMint: accounts.paymentMint,
    },
  };
}

export async function buildStartRentalTransaction(input: {
  itemId: string;
  ownerWallet?: unknown;
  renterWallet?: unknown;
  rentalId: string;
  rentalSeconds: number;
}) {
  const rentProof = deriveRentProofAccounts(input);
  const accounts = rentProof.accounts;
  const renter = new PublicKey(accounts.renter);
  const connection = new Connection(SOLANA_RPC_URL, "confirmed");
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");

  const instruction = new TransactionInstruction({
    programId: RENTAL_SESSION_PROGRAM_ID,
    keys: [
      { pubkey: new PublicKey(accounts.config), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(accounts.item), isSigner: false, isWritable: true },
      { pubkey: renter, isSigner: true, isWritable: true },
      { pubkey: new PublicKey(accounts.session), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(accounts.rentalToken), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(accounts.escrowTokenAccount), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(accounts.escrowAuthority), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(accounts.renterTokenAccount), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(accounts.paymentMint), isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: startRentalInstructionData({
      rentalIdHash: rentProof.rentalIdHash,
      rentalSeconds: input.rentalSeconds,
    }),
  });

  const transaction = new Transaction({
    feePayer: renter,
    recentBlockhash: blockhash,
  }).add(
    createAssociatedTokenAccountIdempotentInstruction(
      renter,
      new PublicKey(accounts.renterTokenAccount),
      renter,
      new PublicKey(accounts.paymentMint)
    ),
    instruction
  );

  return {
    rentProof,
    transactionBase64: transaction
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64"),
    blockhash,
    lastValidBlockHeight,
    cluster: SOLANA_CLUSTER,
    rpcUrl: SOLANA_RPC_URL,
  };
}

export async function buildRequestReturnTransaction(input: {
  itemId: string;
  ownerWallet?: unknown;
  renterWallet?: unknown;
  rentalId: string;
}) {
  const rentProof = deriveRentProofAccounts(input);
  const accounts = rentProof.accounts;
  const renter = new PublicKey(accounts.renter);
  const connection = new Connection(SOLANA_RPC_URL, "confirmed");
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");

  const instruction = new TransactionInstruction({
    programId: RENTAL_SESSION_PROGRAM_ID,
    keys: [
      { pubkey: new PublicKey(accounts.item), isSigner: false, isWritable: true },
      { pubkey: renter, isSigner: true, isWritable: true },
      { pubkey: new PublicKey(accounts.session), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(accounts.rentalToken), isSigner: false, isWritable: false },
    ],
    data: requestReturnInstructionData(),
  });

  const transaction = new Transaction({
    feePayer: renter,
    recentBlockhash: blockhash,
  }).add(instruction);

  return {
    rentProof,
    transactionBase64: transaction
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64"),
    blockhash,
    lastValidBlockHeight,
    cluster: SOLANA_CLUSTER,
    rpcUrl: SOLANA_RPC_URL,
  };
}

export async function buildSettleRentalTransaction(input: {
  kind: "confirm_return" | "auto_buyout";
  itemId: string;
  ownerWallet?: unknown;
  renterWallet?: unknown;
  payerWallet?: unknown;
  rentalId: string;
}) {
  const rentProof = deriveRentProofAccounts(input);
  const accounts = rentProof.accounts;
  const owner = new PublicKey(accounts.owner);
  const payer = input.kind === "auto_buyout" ? publicKeyOrFallback(input.payerWallet, owner) : owner;
  const connection = new Connection(SOLANA_RPC_URL, "confirmed");
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const settleKeys =
    input.kind === "confirm_return"
      ? [
          { pubkey: new PublicKey(accounts.config), isSigner: false, isWritable: false },
          { pubkey: new PublicKey(accounts.item), isSigner: false, isWritable: true },
          { pubkey: owner, isSigner: true, isWritable: true },
          { pubkey: new PublicKey(accounts.renter), isSigner: false, isWritable: true },
          { pubkey: new PublicKey(accounts.feeAuthority), isSigner: false, isWritable: false },
          { pubkey: new PublicKey(accounts.session), isSigner: false, isWritable: true },
          { pubkey: new PublicKey(accounts.rentalToken), isSigner: false, isWritable: true },
          { pubkey: new PublicKey(accounts.escrowTokenAccount), isSigner: false, isWritable: true },
          { pubkey: new PublicKey(accounts.escrowAuthority), isSigner: false, isWritable: false },
          { pubkey: new PublicKey(accounts.renterTokenAccount), isSigner: false, isWritable: true },
          { pubkey: new PublicKey(accounts.ownerTokenAccount), isSigner: false, isWritable: true },
          { pubkey: new PublicKey(accounts.platformFeeTokenAccount), isSigner: false, isWritable: true },
          { pubkey: new PublicKey(accounts.paymentMint), isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ]
      : [
          { pubkey: new PublicKey(accounts.config), isSigner: false, isWritable: false },
          { pubkey: new PublicKey(accounts.item), isSigner: false, isWritable: true },
          { pubkey: payer, isSigner: true, isWritable: true },
          { pubkey: owner, isSigner: false, isWritable: true },
          { pubkey: new PublicKey(accounts.renter), isSigner: false, isWritable: true },
          { pubkey: new PublicKey(accounts.feeAuthority), isSigner: false, isWritable: false },
          { pubkey: new PublicKey(accounts.session), isSigner: false, isWritable: true },
          { pubkey: new PublicKey(accounts.rentalToken), isSigner: false, isWritable: true },
          { pubkey: new PublicKey(accounts.escrowTokenAccount), isSigner: false, isWritable: true },
          { pubkey: new PublicKey(accounts.escrowAuthority), isSigner: false, isWritable: false },
          { pubkey: new PublicKey(accounts.renterTokenAccount), isSigner: false, isWritable: true },
          { pubkey: new PublicKey(accounts.ownerTokenAccount), isSigner: false, isWritable: true },
          { pubkey: new PublicKey(accounts.platformFeeTokenAccount), isSigner: false, isWritable: true },
          { pubkey: new PublicKey(accounts.paymentMint), isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ];

  const instruction = new TransactionInstruction({
    programId: RENTAL_SESSION_PROGRAM_ID,
    keys: settleKeys,
    data: settleRentalInstructionData(input.kind),
  });

  const transaction = new Transaction({
    feePayer: payer,
    recentBlockhash: blockhash,
  }).add(
    createAssociatedTokenAccountIdempotentInstruction(
      payer,
      new PublicKey(accounts.renterTokenAccount),
      new PublicKey(accounts.renter),
      new PublicKey(accounts.paymentMint)
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      payer,
      new PublicKey(accounts.ownerTokenAccount),
      owner,
      new PublicKey(accounts.paymentMint)
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      payer,
      new PublicKey(accounts.platformFeeTokenAccount),
      new PublicKey(accounts.feeAuthority),
      new PublicKey(accounts.paymentMint)
    ),
    instruction
  );

  return {
    rentProof,
    transactionBase64: transaction
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64"),
    blockhash,
    lastValidBlockHeight,
    cluster: SOLANA_CLUSTER,
    rpcUrl: SOLANA_RPC_URL,
    feePayer: payer.toBase58(),
    requiredSigner: payer.toBase58(),
  };
}

export async function buildMemoReceiptTransaction(input: {
  ownerWallet: string | PublicKey;
  receiptMemo: string;
}) {
  const owner = publicKeyFromInput(input.ownerWallet, "ownerWallet");
  const connection = new Connection(SOLANA_RPC_URL, "confirmed");
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const instruction = new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [{ pubkey: owner, isSigner: true, isWritable: false }],
    data: Buffer.from(input.receiptMemo, "utf8"),
  });
  const transaction = new Transaction({
    feePayer: owner,
    recentBlockhash: blockhash,
  }).add(instruction);

  return {
    transactionBase64: transaction
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64"),
    requiredSigner: owner.toBase58(),
    feePayer: owner.toBase58(),
    memoProgram: MEMO_PROGRAM_ID.toBase58(),
    blockhash,
    lastValidBlockHeight,
    cluster: SOLANA_CLUSTER,
    rpcUrl: SOLANA_RPC_URL,
  };
}
