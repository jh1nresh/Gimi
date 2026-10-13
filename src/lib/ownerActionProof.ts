import { createPublicKey, verify } from "node:crypto";
import bs58 from "bs58";

export type OwnerAction = "mark_handed_off" | "confirm_card_return" | "confirm_provider_return" | "pause_listing" | "make_listing_available";

export interface OwnerActionProof {
  address: string;
  message: string;
  signature: string;
}

const MAX_PROOF_AGE_MS = 5 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 30 * 1000;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function buildOwnerActionMessage(input: {
  action: OwnerAction;
  intentId: string;
  ownerWallet: string;
  issuedAt: string;
}) {
  return [
    "Gimi owner action",
    `Action: ${input.action}`,
    `Intent: ${input.intentId}`,
    `Owner: ${input.ownerWallet}`,
    `Issued at: ${input.issuedAt}`,
  ].join("\n");
}

export function verifyOwnerActionProof(input: {
  proof: unknown;
  action: OwnerAction;
  intentId: string;
  ownerWallet: string;
  now?: Date;
}) {
  const proof = parseProof(input.proof);
  if (proof.address !== input.ownerWallet) throw new Error("Owner proof address does not match the rental owner");

  const issuedAt = extractIssuedAt(proof.message);
  const expectedMessage = buildOwnerActionMessage({
    action: input.action,
    intentId: input.intentId,
    ownerWallet: input.ownerWallet,
    issuedAt,
  });
  if (proof.message !== expectedMessage) throw new Error("Owner proof does not match this rental action");

  const issuedAtMs = Date.parse(issuedAt);
  const nowMs = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(issuedAtMs)) throw new Error("Owner proof timestamp is invalid");
  if (issuedAtMs > nowMs + MAX_FUTURE_SKEW_MS) throw new Error("Owner proof timestamp is in the future");
  if (nowMs - issuedAtMs > MAX_PROOF_AGE_MS) throw new Error("Owner proof has expired");

  let publicKeyBytes: Uint8Array;
  let signatureBytes: Uint8Array;
  try {
    publicKeyBytes = bs58.decode(proof.address);
    signatureBytes = bs58.decode(proof.signature);
  } catch {
    throw new Error("Owner proof uses invalid base58 encoding");
  }
  if (publicKeyBytes.length !== 32 || signatureBytes.length !== 64) {
    throw new Error("Owner proof has invalid key or signature length");
  }

  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyBytes)]),
    format: "der",
    type: "spki",
  });
  if (!verify(null, Buffer.from(proof.message, "utf8"), publicKey, signatureBytes)) {
    throw new Error("Owner proof signature is invalid");
  }
  return proof;
}

function parseProof(value: unknown): OwnerActionProof {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Owner wallet signature is required");
  const record = value as Record<string, unknown>;
  const address = typeof record.address === "string" ? record.address.trim() : "";
  const message = typeof record.message === "string" ? record.message : "";
  const signature = typeof record.signature === "string" ? record.signature.trim() : "";
  if (!address || !message || !signature || message.length > 1000 || signature.length > 140) {
    throw new Error("Owner wallet signature is incomplete");
  }
  return { address, message, signature };
}

function extractIssuedAt(message: string) {
  const line = message.split("\n").find((entry) => entry.startsWith("Issued at: "));
  if (!line) throw new Error("Owner proof timestamp is missing");
  return line.slice("Issued at: ".length);
}
