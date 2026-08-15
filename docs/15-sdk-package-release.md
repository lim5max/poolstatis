# SDK package release

`@poolstatis/sdk@0.4.0` adds the separate opt-in `./replay` export while keeping
all four public `0.3.0` exports byte-contract compatible. A source version is
not registry proof: the replay install command remains blocked until npm
read-back returns the exact `0.4.0` artifact.

## Trusted Publisher binding

Before the first dispatch, an npm package owner must bind `@poolstatis/sdk` to:

- repository `lim5max/poolstatis`;
- workflow `publish-sdk.yml`;
- environment left empty unless the npm publisher is configured with one.

The workflow must already exist on `main` before this binding can be created.
Do not dispatch it until the owner confirms the binding.

## Exact artifact gates

`.github/workflows/publish-sdk.yml` is manual and main-only. Its required
`expected_sha` must equal the checked-out commit. Node 24 performs a frozen
SDK-only install, runs all SDK tests, typecheck and build, refuses an existing
registry version, then packs exactly once.

The 16-file tarball allowlist is unpacked and scanned for private keys plus
high-entropy Poolstatis/npm tokens. A clean consumer proves the four prior
`0.3.0` exports, the new `@poolstatis/sdk/replay` export, exact optional
`@rrweb/record@2.1.1`, and a zero-vulnerability production audit. The workflow
also creates and validates a reproducible CycloneDX SBOM with pinned
`@cyclonedx/cyclonedx-npm@6.0.1`.

Only that tested tarball is published with npm Trusted Publishing,
`id-token: write` and `--provenance`; no long-lived npm token is used. Release
completion requires terminal workflow success followed by `npm view` version,
integrity and tarball read-back plus a fresh install/import smoke. The previous
published `0.3.0` fixture must continue to pass Core compatibility tests.
After publication, rerun the checked-in registry proof with
`POOLSTATIS_VERIFY_PUBLISHED_SDK=true pnpm --dir sdk test`.
