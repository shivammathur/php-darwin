# PHP Darwin maintenance

See `README.md` for usage and `docs/maintenance.md` for workflow operations.

- `conf/` defines versions, variants, platforms and archive policy.
- `conf/cached-extensions/<PHP minor>` lists one extension name per line.
  `conf/zend-extensions` identifies names loaded with `zend_extension`.
- `conf/extension-packs.json` defines optional packs, rebuilt independently from
  published PHP by `cache-extensions.yml`.
- Production code lives under `scripts/{build,cache,installer,release,lib}/`.
  Test suites and helpers live in `scripts/tests/`; templates live in `templates/`.
- `scripts/install.sh` is generated from `conf/install-files`; its public path is
  consumed downstream. Change its inputs and regenerate it rather than editing it.

```sh
bash scripts/installer/generate-install.sh
bash scripts/tests/run.sh
actionlint
```

`run.sh check` runs the build preflight; `unit` and `integration` select local
suites. Native cache and published-install checks run in GitHub Actions.

Builds prefer Cloudflare for bottles; normal PHP installs prefer GitHub Releases
with a checksum-verified Cloudflare fallback. Source-cache keys include software and dependency versions, platform and PHP ABI.
Repository code, recipe bytes and runner toolchain changes do not invalidate them. Archives include a pinned Homebrew tap
snapshot matching PHP; `tap_snapshot` is its path relative to the Homebrew prefix.

Installation preserves existing PHP kegs, configuration and services, and makes
cached PHP the default through the archived `bin/php` link. Compatibility gates
check correctness and preservation. Production installers and routine install tests
contain no timing probes or performance gates. Separate performance experiments
may report timings as workflow artifacts; source builds retain verbose configure/make output.

## Workflows

| Workflow | Purpose |
| --- | --- |
| `cache-stable.yml` / `cache-nightly.yml` | Build, test and publish a PHP cache |
| `update-extensions.yml` / `cache-extensions.yml` | Refresh separate extension packs every six hours and validate before publishing |
| `update.yml` / `update-nightly.yml` | Detect changes and dispatch builds |
| `cache-bottles.yml` | Populate Cloudflare with exact upstream dependency bottles |
| `cache-source-bottles.yml` | Mirror reusable bottles built from source |
| `mirror.yml` | Mirror published PHP packages or refresh their installers |
| `publish.yml` / `publish-extensions.yml` | Retry publication from validated artifacts without rebuilding |
| `validate.yml` | Run local regression tests and artifact-transfer checks |
| `test-source-cache.yml` | Test native source builds and cold/warm restoration |
| `update-dependencies.yml` | Detect tap dependency changes, plan both architectures, verify cold/warm restores and approve the snapshot |
| `prepare-dependency.yml` / `prepare-build-tool.yml` | Separate per-formula runtime-library and build-tool workers; independent workers run in parallel |
| `test.yml` / `e2e.yml` | Validate build artifacts and published installations |

## Development

The local suite requires Bash, Node.js 24+, Ruby 3.1+, Python 3, jq, Zstd, Git, curl, tar, zip and
unzip. On macOS it uses Homebrew's installed portable Ruby when available.
Native Homebrew and authenticated GitHub tests run separately in Actions.

See [maintenance](docs/maintenance.md) for detailed operations and troubleshooting.

## Dependency transitions

- PHP and optional-extension workflows consume approved dependency bottles. They
  must never upgrade or compile build tools, even during a linked-library transition.
- Tap dependency declarations are fingerprinted separately from source versions
  and bottle hashes. Changed declarations trigger `update-dependencies.yml`;
  unchanged checks stay on Linux. Native Homebrew resolves the affected graph.
- Retain unrelated approved core recipes. Build tools run only in
  `prepare-build-tool.yml`, one formula and architecture per run. Runtime libraries
  use `prepare-dependency.yml`. Schedule all ready workers together; wait only for
  their same-architecture prerequisites. Each worker can compile only its own target.
- Before promotion, verify exact published worker bottles, native linkage, cold
  restores and warm reuse on both architectures. Keep verified download bytes
  when clearing the installed prefix; the final approval cannot compile.
- Successful dependency approval wakes the normal PHP freshness checks. Optional
  extensions wait for successful, current PHP publication, then rebuild only changed
  packs. Queued workflows count as active when preventing duplicate dispatches.
- Removing an obsolete dependency from the snapshot requires graph and source
  provenance checks. Historical remote artifact deletion remains a separate
  maintenance operation; never delete current or protected cache identities.
