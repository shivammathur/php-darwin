# Maintaining PHP Darwin

- Read `README.md` and `docs/maintenance.md` for usage and operations.
- `conf/` owns versions, variants, platforms and archive policy; avoid duplicating them.
- Production code is grouped under `scripts/{build,cache,installer,release,lib}/`.
- Tests and test helpers belong in `scripts/tests/`; templates contain no runnable helpers.
- Keep temporary data, benchmark results and credentials out of Git.

## Validate changes

```sh
bash scripts/installer/generate-install.sh
bash scripts/tests/run.sh
actionlint
```

- Never edit generated `scripts/install.sh`; preserve its public path.
- `run.sh check` is the quick build preflight; `unit` and `integration` select local suites.
- Use Actions for native source-cache, compatibility and published-install tests.
- Inspect logs, checksums, archive metadata and links, not only job status.
- Keep tests focused on behavior; avoid duplicate source-text assertions.

## Compatibility requirements

- Build caching prefers Cloudflare; normal PHP installation prefers GitHub Releases.
- Verify exact bottle/archive digests; preserve manifest schemas and immutable asset names.
- Reuse source builds only when formula, dependency, platform and toolchain inputs match.
- Preserve existing PHP kegs, configuration, services and unrelated Homebrew state.
- The cache supplies the default `bin/php` link; never remove another PHP installation.
- Keep installs strictly below 10 seconds and timing probes outside the installer.
- Keep verbose configure/make output; diagnose causes before adding retries.
- Do not modify setup-php. Passwordless sudo is its prerequisite, not a reason to
  use sudo for ordinary writes to a user-owned Homebrew prefix.

## Repository work

- Push only to `shivammathur` repositories unless explicitly instructed otherwise.
- Do not create PRs, edit PR bodies or start subagents unless requested.
- When a branch is needed, use `fix/` or `feature/`; keep cleanup commits coherent.
- Testing in `shivammathur/test-setup-php` requires a new orphan branch.
- Diagnose related failures together; run independent validation jobs in parallel.
