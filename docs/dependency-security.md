# Dependency security baseline

## October 2026 review — runtime gate restored

The 2026-10-13 review upgraded Next.js and its ESLint config to 16.3.8,
Axios to 1.20.0, Hono to 4.13.7, and PostCSS to 8.5.23, together with compatible
transitive patches. A follow-up removes the two remaining vulnerable dependency
chains without expanding the advisory allowlist:

- Old `@walletconnect/utils` 2.21.x consumers resolve to **2.21.10**, whose
  [upstream manifest](https://github.com/WalletConnect/walletconnect-monorepo/blob/2aace94ce9d87cc13987f66e86310324b23c0fa0/packages/utils/package.json)
  removes `query-string` and its `decode-uri-component` dependency. This is
  scoped to versions below 2.21.10; existing 2.22.4 consumers stay on 2.22.4.
  No CommonJS-to-ESM decoder substitution or vendored parser is needed.
- Only `@solana/web3.js`'s RPC dependency resolves to **jayson 5.0.0**, removing
  `stream-json` and one legacy UUID copy. Its
  [upstream changes](https://github.com/tedeh/jayson/blob/v5.0.0/README.md#changelog-only-notable-milestoneschanges)
  affect TCP/TLS framing and native crypto. Web3 uses `jayson/lib/client/browser`
  for HTTP JSON-RPC, not the changed TCP/TLS transport. Gimi's Next.js runtime
  and CI meet Jayson's Node >=20 requirement. This deliberately crosses Web3's
  declared Jayson major range and must retain the compatibility tests below.

`npm run audit:runtime` now passes with **19 affected package nodes** (zero
critical, nine high, ten moderate), down from 50 before this PR and 37 after the
first patch. These are dependency-graph counts, not independent exploitable
paths. Only the four historical advisory URLs below remain; the audit gate and
its allowlist are unchanged. Passing this gate does **not** mean zero upstream
vulnerabilities or readiness for real-money production.

`tests/dependencyCompatibility.test.ts` exercises the installed dependencies
through their real consumers: wallet pairing URI round trips, escaped/malformed
input, Solana request serialization and IDs, batched responses, provider errors,
and malformed JSON. The installed Jayson browser client also executes in an
isolated context with Web Crypto only, including the getRandomValues fallback.
The production Next build separately verifies bundling. No external RPC or
wallet provider is called by these tests.

Clean `npm ci --ignore-scripts` and `npm ls @walletconnect/utils jayson` validate
lockfile reproducibility and override resolution. Run the unchanged full gate:

```bash
npm run verify:prod-ready
```

See [the repo review](repo-review-2026-10-13.md) for remaining product and payment
acceptance work; a passing dependency gate does not resolve those launch gaps.

## Historical July baseline

The July 2026 dependency hardening pass upgraded the direct framework, auth,
Solana, and Supabase dependencies and pinned patched same-major transitive
releases. The remaining production findings expand from four upstream
advisories through the dependency graph.

The unresolved advisory sources are:

- `bigint-buffer` — `GHSA-3gc7-fjrx-p6mg`;
- `@solana/buffer-layout-utils` — affected through `bigint-buffer`;
- `@solana/spl-token` — affected through `buffer-layout-utils`.
- legacy `uuid` consumers in Privy's optional EVM wallet integrations — `GHSA-w5hq-g745-h8pq`.
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
