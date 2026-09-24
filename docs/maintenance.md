# Maintenance

## Layout

| Path | Responsibility |
| --- | --- |
| `.github/actions/`, `.github/workflows/` | Actions integration and orchestration |
| `conf/` | Versions, variants, platforms, archive policies and installer inputs |
| `scripts/build/` | Formula inputs, build preparation, packaging and reports |
| `scripts/cache/` | Upstream/source bottles, build locks and archive checkpoints |
| `scripts/installer/` | Installation helpers and standalone installer generator |
| `scripts/release/` | Update detection, publishing and mirroring |
| `scripts/lib/` | Shared shell, HTTP, hashing and metrics helpers |
| `scripts/tests/` | Regression tests, native checks, fixtures and test helpers |
| `templates/` | JSON and installer substitution templates; no runnable helpers |
| `scripts/install.sh` | Generated standalone installer; public path must remain stable |

Edit source helpers and `conf/install-files`, then regenerate the installer.
Never edit the generated file directly. It embeds readable shell and configuration
and needs no repository checkout or Node runtime during installation.

## Checks

```sh
bash scripts/installer/generate-install.sh
bash scripts/tests/run.sh check        # Syntax, configuration and generated output
bash scripts/tests/run.sh unit         # Isolated cache and reporting behavior
bash scripts/tests/run.sh integration  # Local CLI, filesystem and HTTP fixtures
bash scripts/tests/run.sh              # All local checks
# Requires actionlint and shellcheck on PATH:
actionlint
```

Local tests use temporary directories and simulated commands. Keep credentials
and real Homebrew mutation out of these suites. Names use `*.test.sh` or
`*.test.cjs`; group tests by purpose, not language. Add fixtures only when they
protect behavior that is not already covered. Test output belongs in temporary
directories or Actions artifacts, not checked-in benchmark reports.

`test-source-cache.yml` exercises real library/consumer source builds, locking,
configuration preservation and Xdebug/PCOV cold/warm reuse. Its release is
isolated per run and removed by its cleanup job. `test.yml` validates all four
variants from an existing build's artifacts. `e2e.yml` checks published downloads
and unchanged setup-php on ARM, Intel and an explicit self-hosted runner.

```sh
gh workflow run test-source-cache.yml -R shivammathur/php-darwin
gh workflow run test.yml -R shivammathur/php-darwin \
  -f php-version=8.4 -f run-id=BUILD_RUN_ID -f runner=macos-15-x86_64
gh workflow run e2e.yml -R shivammathur/php-darwin -f php-version=8.4
```

Tests in `native/` and `e2e/` require workflow-provided state and are not part of
the local runner. Run all applicable suites after installer, cache or workflow
changes, and inspect artifacts and logs as well as job conclusions.

## Build and cache

Each `conf/cached-extensions/<PHP minor>` file contains plain extension names,
one per line. `conf/zend-extensions` lists names requiring the `zend_extension`
INI directive; other names use `extension`. These are build inputs, not runtime
installer configuration.

`conf/versions`, `conf/variants` and `conf/platforms.json` are authoritative.
Builds pin both Homebrew taps, run each architecture/variant independently, then
publish only after required compatibility jobs pass. Stable/nightly update
workflows compare relevant formula and php-src inputs before dispatching work.

```sh
gh workflow run cache-bottles.yml -R shivammathur/php-darwin -f seed=true
gh workflow run cache-source-bottles.yml -R shivammathur/php-darwin -f seed=true
gh workflow run cache-stable.yml -R shivammathur/php-darwin -f php-version=8.4
```

During builds, exact upstream bottle digests are read from Cloudflare into
Homebrew's download cache. Misses fall back to Homebrew's concurrent upstream
fetch and are mirrored afterward, one dependency per job. Retain current bottle
downloads on persistent runners. Never substitute an older bottle for a new digest.

Packages without usable upstream bottles use the `cache` GitHub Release for
source-build metadata and locks. Their bundles also use Cloudflare first.
Keys include recipe, dependency and toolchain inputs; PHP extensions additionally
include PHP API and variant inputs. Unrelated bottle additions must not invalidate
source builds. Existing configuration is restored after source bottling, including
failed builds; service data is not staged. Keep configure/make output visible.

Archive checkpoints last seven days and require matching workflow revision,
inputs and verified payloads. They are separate from reusable source bottles.
Archives use Zstd level 19 with `--long=27`; Actions uploads use compression level
zero. Preserve runtime/development files and licenses under the archive policy.

## Publish and installer updates

Each `php-X.Y` release contains eight architecture/variant archives, a manifest
and `install.sh`. The `tap_snapshot` setting is the archive path
`var/php-darwin/homebrew-php`, relative to the Homebrew prefix. It contains a
shallow Git copy of the exact PHP tap used to build the cache, including formulae
and their shared definitions. The installer validates this snapshot, keeps a
matching installed tap, or uses the bundled tap while preserving existing user
state. This avoids a tap download and mismatched formula definitions during
installation. The snapshot is generated during packaging, not stored in this
repository.

Archives have immutable checksum-addressed names. Verify
checksums, metadata, the complete matrix and public Cloudflare copies before
publishing the installer and manifest. Preserve the manifest schema and asset names.

R2 uses the `php-darwin` bucket and these repository secrets:

- `CF_R2_AWS_ACCESS_KEY_ID`
- `CF_R2_AWS_SECRET_ACCESS_KEY`
- `CF_R2_AWS_S3_ENDPOINT`

The public mirror is `https://artifacts.php-darwin.setup-php.com`. PHP packages
live under `php-X.Y/`; dependency objects live under `homebrew/bottles/sha256/`
and `homebrew/source-bottles/sha256/`. Build locks require `contents: write`
and `actions: read`; archive checkpoint pruning also needs `actions: write`.

Refresh an installer without rebuilding PHP or its dependencies:

```sh
gh workflow run mirror.yml -R shivammathur/php-darwin \
  -f php-version=8.4 -f publish-installers=true
```

R2 verification precedes the GitHub installer update. Installer-only changes
normally reuse published archives; recipe/dependency changes need cache builds.

## Installation and troubleshooting

Normal installs prefer GitHub Releases and fall back to Cloudflare, validating
the final checksum before extraction. `PHP_DARWIN_PREFER_MIRROR=true` explicitly
reverses that order and is used during cache construction. Do not change the
normal setup-php download priority or add retries without diagnosing the cause.

Preserve existing PHP kegs, configuration, services and unrelated Homebrew state.
The archive must supply the default `bin/php` link. A writable Homebrew prefix is
required; ordinary installation into a user-owned prefix needs no sudo.
Passwordless sudo remains a prerequisite for setup-php. Its self-hosted path may
reuse installed PHP or invoke Homebrew; direct release tests establish cache
coverage separately.

Compatibility installs must remain strictly below 10 seconds; direct release
checks include bootstrap and archive downloads. Keep this gate strict and report
existing timing failures. QA helpers record phases through `BASH_ENV` without
adding probes to production installers. `test.yml` has an `trace-install`
input for detailed diagnostics. `PHP_DARWIN_VERIFY_RUNTIME=true` also enables
runtime/extension probes during an installation.

Use the `workflow-performance` and per-build timing artifacts to separate runner
queueing, dependency fetching, source compilation and publication. Check cache
miss records, archive metadata and actual links.

## Optional extension archives

`cache-extensions.yml` restores published PHP caches and builds Imagick, MongoDB
and Memcached independently. It never compiles PHP or adds these libraries to
the PHP archives. `conf/extension-packs.json` defines the supported versions and
the modules belonging to each pack.

`update-extensions.yml` checks every configured PHP version every six hours,
dispatching all versions together within Actions matrix limits.
Its optional `after-run` input waits for a successful prerequisite before dispatching;
failed or cancelled prerequisites stop the follow-up. Unchanged packs are skipped;
changed packs reuse the source-bottle cache. Manual runs can select PHP versions,
extensions and build variants. Builds share one job per PHP version and architecture;
compatibility checks share one job per PHP version and runner, covering every
selected build variant and pack. A complete 14-version campaign uses 28 native
build jobs and 70 compatibility jobs instead of 336 and 280. Each passing pack
is checkpointed separately, even if another pack in its job fails. Native cache
campaigns run on dispatch or schedule; source changes run the local validation CI.
Publication requires native installation and
functional tests on the build platforms, newer hosted macOS, and self-hosted Intel.
Each pack must install in under 10 seconds and preserve PHP and services. Archives
are published to the separate `extensions` release and Cloudflare only after all
selected tests pass. Installer updates are published even when recipes are unchanged.
If publication fails after validation, run `publish-extensions.yml` with that run's
`run-id`. It checks every source build and compatibility job before publishing the
existing artifacts, without rebuilding PHP or extensions.
If builds partly failed or the compatibility workflow needs a fix, run
`recover-extensions.yml` with the completed source `run-id`. It selects only
successful builds, pins their artifact IDs, tests those archives on every required
compatibility platform using the current checks, and publishes exactly that set.
Failed builds remain excluded and can be rebuilt separately. Missing or expired
artifacts stop recovery; rerunning failed recovery jobs preserves passing work.
Recovery API reads use the same bounded service-error policy as publication;
authentication failures and invalid responses stop immediately.
For an interrupted campaign, pass completed `resume-runs` to `cache-extensions.yml`
in oldest-to-newest order. The latest successful artifact for each pack wins.
Ubuntu jobs download exact artifact IDs, verify archive hashes and native reports,
and retain their bytes; Macs only build unpublished gaps and run compatibility.
Already published variants are retained when their PHP release/source commit still
matches. Normal runs without `resume-runs` apply full recipe freshness checks.
This recovery path works for both architectures. Regular Homebrew ARM bottles
cannot replace debug/ZTS or development-PHP extension binaries; missing matching
binaries and Mach-O relocation/signing still require macOS.
Publication resumes by reusing GitHub assets with matching SHA256 digests and
Cloudflare objects whose downloaded bytes pass SHA256 verification. Small archives
use single-object uploads. A transient timeout, connection failure or service error
gets one recovery attempt after five seconds, with at most six recovery attempts
across publication. Checksums, metadata and credential errors are never retried.
Lost upload responses are reconciled with the remote object before another write.
Manifests are committed only after every referenced archive is verified. Failed
jobs include recovery instructions and a publication report; publication has a
30-minute limit. These recovery rules do not add retries to the installer.
Nightly packs also track the PHP source commit, so a new nightly with the same
version string rebuilds its extension modules while reusing dependency bottles.

Each archive carries private runtime libraries, relocated Mach-O load paths,
licenses and module metadata. The standalone `scripts/installer/install-extensions.cjs`
prefetches requested packs concurrently, then installs only packs matching the
installed PHP API, architecture and build variant. Downloads prefer GitHub Releases
and fall back to Cloudflare. No Homebrew commands run in the extension installer.
