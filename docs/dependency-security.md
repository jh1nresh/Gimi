# Dependency security baseline

## October 2026 review — release gate blocked

The 2026-10-13 review upgraded Next.js and its ESLint config to 16.3.8,
Axios to 1.20.0, Hono to 4.13.7, and PostCSS to 8.5.23. The lockfile also
updates compatible Sharp, baseline-browser-mapping, fast-copy, nanoid,
socket.io-parser, and source-map-js dependencies. No advisory allowlist was
expanded and no forced major transitive override was introduced.

The runtime audit moved from 50 affected package nodes (one critical) to
37 (zero critical, nine high, 28 moderate). These are dependency-graph counts,
not independent exploitable paths. `npm run audit:runtime` still **fails** on
four advisory URLs beyond the historical allowlist:

- `decode-uri-component`, via WalletConnect's pinned `query-string@7.1.3`:
  [GHSA-vcc3-ghjq-m6fr](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr).
  Version 0.5.0 is ESM, while query-string 7 requires its decoder as CommonJS;
  blindly overriding the decoder would break that API. A compatible parent
  upgrade or a separately verified backport is required.
- `stream-json`, via `@solana/web3.js@1.98.4` → `jayson@4.3.0`:
  [GHSA-528h-pc64-c93x](https://github.com/advisories/GHSA-528h-pc64-c93x),
  [GHSA-hqr4-qq8f-hg3x](https://github.com/advisories/GHSA-hqr4-qq8f-hg3x), and
  [GHSA-mjw6-4jj6-33hc](https://github.com/advisories/GHSA-mjw6-4jj6-33hc).
  No patched 1.x release is available. Jayson 5 removes stream-json but changes
  its transport/runtime contract and falls outside Web3's declared range;
  that migration needs independent RPC/browser compatibility evidence.

The PR must remain pending while this required gate fails. The dependency
updates remove the observed critical advisory but do not establish production
readiness. See [the audit and remaining launch work](repo-review-2026-10-13.md).

## Historical July baseline

The July 2026 dependency hardening pass upgraded the direct framework, auth,
Solana, and Supabase dependencies and pinned patched same-major transitive
releases. The remaining production findings expand from four upstream
advisories through the dependency graph.

The unresolved advisory sources are:

- `bigint-buffer` — `GHSA-3gc7-fjrx-p6mg`;
- `@solana/buffer-layout-utils` — affected through `bigint-buffer`;
- `@solana/spl-token` — affected through `buffer-layout-utils`.
- legacy `uuid` consumers in Privy's optional EVM wallet integrations and
  Solana Web3's RPC helper — `GHSA-w5hq-g745-h8pq`.
- WebSocket 8 consumers below their next compatible parent release —
  `GHSA-58qx-3vcg-4xpx` and `GHSA-96hv-2xvq-fx4p`.

There is no patched `bigint-buffer` release. npm's proposed fix downgrades
`@solana/spl-token` to `0.1.8`, which is incompatible with Gimi's current Solana
transaction code and is not an acceptable security fix.

## Current exposure

Gimi reaches `bigint-buffer` through fixed-width Solana token layouts. Current
layouts decode 8-, 16-, 24-, or 32-byte values rather than attacker-selected
buffer lengths. On the verified local runtime the optional native binding does
not load and the package uses its pure-JavaScript conversion path.

Gimi does not call the affected UUID v3/v5/v6 buffer-output API. The vulnerable
UUID releases remain because their parent packages declare UUID 8 or 9;
force-installing UUID 11 would cross their compatibility contract.
The vulnerable WebSocket 8 releases are transitive dependencies of Privy's EVM
connector graph. Gimi configures Privy for Solana wallets, but keeps the
upstream graph intact instead of forcing a version npm reports as invalid.
That optional EVM subtree also emits a React 19 peer warning during install;
standard `npm ci` still completes without `legacy-peer-deps`.

These constraints reduce reachability but do not remove the upstream risk.
Before a mainnet launch, replace the legacy `@solana/spl-token` path with the
maintained generated token client or an upstream patched release, and upgrade
the remaining UUID parents when compatible releases are available.

## Enforcement

Run:

```bash
npm run audit:runtime
```

The command allows only the four advisory URLs above, regardless of how many
transitive package nodes npm expands from them. Any new advisory source, an
incomplete audit response, or any critical advisory fails the check.

The package lock also pins patched same-major transitive versions for Axios,
FormData, Hono, Lodash, and PostCSS. Standard `npm ci` remains the
supported install path; no global peer-dependency bypass is used.
