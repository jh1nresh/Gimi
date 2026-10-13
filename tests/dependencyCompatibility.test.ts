import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { Connection, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
// Resolve through the real consumers, so nested SDK dependencies are exercised.
const walletRequire = createRequire(require.resolve("@wagmi/connectors"));
const walletUtils = walletRequire("@walletconnect/utils") as {
  parseUri(uri: string): { topic: string; version: number; symKey: string; relay: { protocol: string }; methods?: string[]; expiryTimestamp?: number };
  formatUri(params: Record<string, unknown>): string;
};

type RpcRequest = { id: string; jsonrpc: string; method: string; params: unknown[] };
function rpcConnection(reply: (request: RpcRequest | RpcRequest[]) => unknown) {
  const requests: (RpcRequest | RpcRequest[])[] = [];
  const connection = new Connection("https://rpc.invalid", {
    commitment: "confirmed",
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as RpcRequest | RpcRequest[];
      requests.push(request);
      const response = reply(request);
      return new Response(typeof response === "string" ? response : JSON.stringify(response));
    },
  });
  return { connection, requests };
}

const owner = new PublicKey("11111111111111111111111111111111");

describe("Solana RPC dependency compatibility", () => {
  it("serializes requests, generates distinct IDs and decodes RPC results", async () => {
    const { connection, requests } = rpcConnection((raw) => {
      const request = raw as RpcRequest;
      return { jsonrpc: "2.0", id: request.id, result: { context: { slot: 100 }, value: 123456789 } };
    });
    expect(await connection.getBalance(owner)).toBe(123456789);
    expect(await connection.getBalance(owner)).toBe(123456789);
    const [first, second] = requests as RpcRequest[];
    expect(first).toMatchObject({ jsonrpc: "2.0", method: "getBalance", params: [owner.toBase58(), { commitment: "confirmed" }] });
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(second.id).not.toBe(first.id);
  });

  it("preserves batched requests and null transaction results", async () => {
    const { connection, requests } = rpcConnection((raw) => (raw as RpcRequest[]).map((request) => ({
      jsonrpc: "2.0", id: request.id, result: null,
    })));
    expect(await connection.getParsedTransactions(["signature-one", "signature-two"])).toEqual([null, null]);
    const batch = requests[0] as RpcRequest[];
    expect(batch.map((request) => request.method)).toEqual(["getTransaction", "getTransaction"]);
    expect(batch.map((request) => request.params[0])).toEqual(["signature-one", "signature-two"]);
    expect(new Set(batch.map((request) => request.id)).size).toBe(2);
  });

  it("propagates provider errors instead of treating them as successful balances", async () => {
    const { connection } = rpcConnection((raw) => ({
      jsonrpc: "2.0", id: (raw as RpcRequest).id, error: { code: -32602, message: "Invalid params" },
    }));
    await expect(connection.getBalance(owner)).rejects.toThrow("Invalid params");
  });

  it("rejects malformed provider JSON", async () => {
    const { connection } = rpcConnection(() => "{not-json");
    await expect(connection.getBalance(owner)).rejects.toThrow();
  });

  it("runs the installed RPC browser client with Web Crypto only, including its UUID fallback", () => {
    const web3Require = createRequire(require.resolve("@solana/web3.js"));
    const clientPath = web3Require.resolve("jayson/lib/client/browser");
    for (const crypto of [webcrypto, { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) }]) {
      const cache = new Map<string, { exports: unknown }>();
      const load = (filename: string): unknown => {
        const cached = cache.get(filename);
        if (cached) return cached.exports;
        const loadedModule = { exports: {} as unknown };
        cache.set(filename, loadedModule);
        const localRequire = createRequire(filename);
        runInNewContext(readFileSync(filename, "utf8"), {
          module: loadedModule, exports: loadedModule.exports, crypto,
          require: (specifier: string) => {
            // Browser client must not need Node built-ins or a Node crypto shim.
            if (!specifier.startsWith(".")) throw new Error(`Unexpected browser dependency: ${specifier}`);
            return load(localRequire.resolve(specifier));
          },
        }, { filename, timeout: 1000 });
        return loadedModule.exports;
      };
      type Client = { request(method: string, params: unknown[], callback: (error: Error | null, response: { result: number }) => void): void };
      const RpcClient = load(clientPath) as new (send: (body: string, callback: (error: null, response: string) => void) => void) => Client;
      let responseValue: number | undefined;
      const client = new RpcClient((body, callback) => {
        const request = JSON.parse(body) as RpcRequest;
        expect(request.id).toMatch(/^[0-9a-f-]{36}$/i);
        expect(request.params).toEqual([owner.toBase58()]);
        callback(null, JSON.stringify({ jsonrpc: "2.0", id: request.id, result: 42 }));
      });
      client.request("getBalance", [owner.toBase58()], (error, response) => {
        expect(error).toBeNull();
        responseValue = response.result;
      });
      expect(responseValue).toBe(42);
    }
  });
});

describe("WalletConnect dependency compatibility", () => {
  const params = {
    protocol: "wc", topic: "a".repeat(64), version: 2, symKey: "b".repeat(64),
    relay: { protocol: "irn" }, methods: ["personal_sign", "eth_sendTransaction"], expiryTimestamp: 2000000000,
  };

  it("round-trips pairing fields used by the wallet connector", () => {
    const uri = walletUtils.formatUri(params);
    expect(uri).toMatch(/^wc:/);
    expect(walletUtils.parseUri(uri)).toMatchObject({
      topic: params.topic, version: 2, symKey: params.symKey, relay: params.relay,
      methods: params.methods, expiryTimestamp: params.expiryTimestamp,
    });
  });

  it("decodes escaped values and handles malformed percent encoding without recursive decoding", () => {
    const parsed = walletUtils.parseUri(`wc:${params.topic}@2?relay-protocol=irn&symKey=${params.symKey}&methods=personal_sign%2Ceth_sendTransaction`);
    expect(parsed.methods).toEqual(params.methods);
    // This malformed UTF-8 shape triggered exponential work in the old decoder.
    const malformed = "%A9".repeat(10000);
    const result = walletUtils.parseUri(`wc:${params.topic}@2?relay-protocol=${malformed}&symKey=${params.symKey}&__proto__=polluted`);
    expect(result.topic).toBe(params.topic);
    expect(result.symKey).toBe(params.symKey);
    expect(result.relay.protocol.length).toBeGreaterThan(0);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  }, 2000);
});
