# PHP Darwin

<a href="https://github.com/shivammathur/php-darwin/actions/workflows/cache-stable.yml" title="PHP Package Cache"><img alt="Build status" src="https://github.com/shivammathur/php-darwin/actions/workflows/cache-stable.yml/badge.svg"></a>
<a href="https://github.com/shivammathur/php-darwin/blob/main/LICENSE" title="license"><img alt="LICENSE" src="https://img.shields.io/badge/license-MIT-428f7e.svg?logo=open%20source%20initiative&logoColor=white&labelColor=555555"></a>
<a href="https://github.com/shivammathur/php-darwin/releases" title="builds"><img alt="PHP Versions Supported" src="https://img.shields.io/badge/php-5.6%20to%208.7-777bb3.svg?logo=php&logoColor=white&labelColor=555555"></a>

> Cache Homebrew PHP packages for fast installation on GitHub Actions macOS runners.

Archives retain runtime/development files and licenses; general documentation, man pages, and info pages are omitted.

## PHP versions

- Stable: PHP 5.6 through PHP 8.5
- Nightly: PHP 8.6 and PHP 8.7
- Variants: NTS and ZTS, debug and release
- Architectures: ARM64 and x86_64

## Labels and tags

| Architecture | Build label | Test labels | Platform tag |
|---|---|---|---|
| ARM64 | `macos-14` | `macos-14`, `macos-15`, `macos-26`, `macos-latest` | `arm64_sonoma` |
| x86_64 | `macos-15-intel` | `macos-15-intel`, `macos-15-x86_64` (self-hosted), `macos-26-intel` | `sequoia` |

The self-hosted Intel runners have both `macos-15-intel` and
`macos-15-x86_64` labels. They build packages alongside GitHub-hosted Intel
runners, and the separate test label ensures compatibility tests install each
cache on a self-hosted runner.

Each PHP minor uses a release tag such as `php-8.5`. The release manifest maps a
logical name such as `php_8.5-nts-release+darwin_arm64.tar.zst` to an immutable,
checksum-addressed archive. New patch releases update the manifest without replacing archives in place.

Downloads fall back to `https://artifacts.php-darwin.setup-php.com` when GitHub
fails. R2 uses the same version directories, immutable filenames, and SHA-256
checksums, for example `php-8.5/php_8.5-nts-release+darwin_arm64.<sha256>.tar.zst`.
Each directory also has `install.sh` and `php-8.5-manifest.json`. Archives are
cached for one year; installers and manifests require revalidation on every
request. The installer verifies bytes from either origin before extraction.

The verified archive's formula list supplies Homebrew trust entries. On supported
Homebrew installations, the installer merges those entries into the current
user's `trust.json` under Homebrew's file lock, without starting `brew trust`.
It preserves existing taps, formulae, casks, and commands, writes atomically with
private permissions, and records only newly added entries for rollback.
Unrecognized storage formats, custom tap remotes, symlinks, and `brew.env`
configuration use Homebrew's command instead. No build machine trust file is
included in the cache, and installing a formula does not trust its entire tap.
The installer also avoids repeated Homebrew startup when unlinking ordinary
kegs and checking installed dependency receipts. It locks the affected formulae,
records removed symlinks for rollback, and preserves unrelated files and links.
Unusual alias layouts and info-index maintenance still use Homebrew. Dependency checks
cover the runtime receipts of every cached package; unfamiliar receipt formats
fall back to `brew missing`.

Normal installation reads the literal version in `php-config` and checks it
against the authenticated archive metadata without executing PHP or sourcing
the configuration script. It also checks the PHP executable, cached module
files, dependency receipts and installed links. Release QA executes PHP and
loads each extension on the supported runners before publication. Set
`PHP_DARWIN_VERIFY_RUNTIME=true` to repeat those load probes during installation
when diagnosing a runner-specific failure.

Package planning and opt-link updates are batched, with previous link targets
journaled for rollback. Existing PEAR files and managed configuration that will
be preserved are excluded from extraction. Tap commit comparisons use local
Git history; incomplete history preserves the installed tap transactionally
without an additional GitHub API request. Downloads stop at HTTP error headers
and try the next origin without waiting for an error response body.

Installer timing instrumentation lives on the
[`debug/install-timing` branch](https://github.com/shivammathur/php-darwin/tree/debug/install-timing).
Production installers contain no timing wrappers, clock probes, or timing logs;
they retain phase-specific error messages and recovery diagnostics. To profile
an install, use that branch's generated installer with `PHP_DARWIN_TIMING=true`.
Timing flags do not enable instrumentation in the production installer.

Helpers use Homebrew's installed portable Ruby directly after checking its
required standard libraries. If that runtime is unavailable or unusable, they
use the system Ruby; no additional interpreter is downloaded.

Publishing verifies the R2 copies before updating the GitHub installer and
manifest. The repository secrets `CF_R2_AWS_ACCESS_KEY_ID`,
`CF_R2_AWS_SECRET_ACCESS_KEY`, and `CF_R2_AWS_S3_ENDPOINT` provide an R2 token
scoped to object access in the `php-darwin` bucket. The **Mirror published PHP
releases** workflow can backfill one version or all versions without compiling
anything. Its optional installer update refreshes GitHub installers only after
R2 verification and a check that the release manifest has not changed. If R2
already has that exact manifest, an installer refresh reuses the verified
archives without downloading or uploading them again.

Update checks compare formula source and the bottles usable on the cache build
platforms. Adding bottles for newer macOS versions (including macOS 27) does not
rebuild the shared architecture caches. Full formula hashes remain in the cache
metadata for integrity validation. When no compatible bottle exists, Homebrew
builds from source on the same runner; macOS 14 ARM64 remains the cache minimum
even after its bottles stop being published.

The nightly update schedule starts separate cache workflow runs for PHP 8.6
and PHP 8.7. Each run uses the same php-src freshness gate, architecture
builds, publishing, and setup-php tests. Manual cache runs select one PHP minor
and default to PHP 8.6.

During cache builds, missing PHP, library, Xdebug, and PCOV bottles are built with
`brew install --build-bottle` and saved individually in the `cache`
stable GitHub Release. Asset labels show the package, version, macOS major,
architecture, PHP variant when applicable, and a short build key, for example
`xdebug@8.4-3.5.3.macos-14.arm64.release-nts.dc8af3b8dbdf.tar`.
Download filenames retain the readable package information plus the full family
and build hashes for exact matching and cleanup. Each asset contains the native
Homebrew bottle and `metadata.json` with its SHA-256 and complete build inputs.
The release lists packages compiled from source; upstream bottles are not copied
into it. The cache release is stable but is not designated the latest release.
Later runs restore them with Homebrew, including its normal linking and
post-install configuration. Library bottles are shared across PHP versions;
the four PHP variants have separate entries, as do their extension builds. For example, a PHP update reuses
an unchanged libxml2, while a libxml2 update rebuilds both libxml2 and PHP.

Keys cover package version/revision, formula source, installed dependency
versions/recipes/options, architecture, macOS major, Homebrew major, compiler,
and SDK. Extension keys also cover the patched shared base formula and the
installed PHP version, API, and configure options. Unrelated bottle updates do not invalidate source builds. Existing
runner dependencies and usable upstream bottles retain priority; debug/ZTS
extensions use their own source bottles. Upstream GHCR bottles are first read
from the Cloudflare R2 `php-darwin` bucket under
`homebrew/bottles/sha256/<digest>.tar.gz`. The builder verifies the formula's exact
SHA-256 and atomically places each bottle in Homebrew's own download cache;
Homebrew retains responsibility for metadata, relocation, receipts, and linking.
Eight concurrent reads avoid serial downloads. Existing verified local bottles
are retained, and cache misses or invalid objects fall back to Homebrew's normal
concurrent upstream fetch. This only changes build preparation, not the PHP
package installer.

Run `cache-bottles.yml` with `seed=true` to resolve all configured PHP versions,
four variants, cached extensions, and build tools on both minimum macOS platforms.
Resolution ignores preinstalled packages and includes transitive source-build
dependencies. One Ubuntu job per dependency copies its exact ARM/Intel bottles
and verifies their public Cloudflare downloads. No package installation is needed
to seed the mirror. Formulae without upstream bottles continue through the existing
source-bottle cache described above. Builders record misses as artifacts; at the
end of each package workflow the same reusable bottle workflow deduplicates those
records and caches only the missing dependencies, also one job per dependency.
New digests get new immutable objects; the cache never substitutes an older version.
Each job publishes checksum verification evidence, and build timing artifacts
record Cloudflare hits, local hits, and misses. Persistent runners retain
current bottle downloads across builds. Assets do not expire. After uploading
and downloading a replacement to verify its checksum, the builder deletes older
package versions for the same architecture, macOS, and PHP variant. It preserves
newer versions uploaded by concurrent runs and different build inputs for the
current version. Missing or invalid bottle data falls back to source builds.
Before compiling a missing key, a builder claims a small `source-build-lock-*.json`
asset in the same release. Concurrent jobs wait, then recheck for the completed
bottle. Claims are removed on completion; interrupted claims are reclaimed only
after the owning Actions job has ended. If ownership cannot be established after
bounded API retries, the job fails instead of starting a duplicate build.
Polling backs off and uses GitHub's ETags to revalidate unchanged state without
consuming the primary API quota.
Build jobs need `contents: write` to maintain this release and `actions: read`
to check ownership. Run
`test-source-cache.yml` to verify compilation, release storage, remote restoration,
linkage, consumer updates, and real Xdebug/PCOV modules for all four PHP variants
on both cache build platforms. Tests use a separate release that is removed afterward.
Release-cache requests have bounded timeouts and retries for transient network,
server, and rate-limit errors. Empty incomplete uploads are ignored on restore;
a later upload of the same key removes them after 30 minutes, with a fresh state
check to preserve uploads that have completed. Artifact downloads retry up to three times while
requiring valid digests. Workflow and script changes run the local validation
suite automatically in CI; publication still requires successful builds and
compatibility tests for every selected platform.

## Avoiding repeated work

Queued cache workflows recheck the published inputs before allocating macOS
runners. `force` bypasses this check; an unpublished test matrix is also allowed
to run explicitly. Nightly checks include both php-src and normalized formula
inputs, so recipe changes rebuild while unrelated macOS bottle additions do not.

Each PHP variant builds in a separate matrix job: release/NTS, release/ZTS,
debug/NTS, and debug/ZTS for each selected architecture. A full build has eight
independent build jobs. Each variant is verified and uploaded immediately as a
separate Actions artifact, with its own timing artifact. Retries can reuse
these archive checkpoints for seven days when the workflow revision, pinned
taps, compiler/SDK, installed dependency recipes and bytes, PHP variant, and
extension bytes all match. Homebrew-generated installation receipts and SBOM
timestamps do not invalidate identical package payloads. GitHub's artifact digest,
archive checksum, metadata, and native archive checks are verified again on
restore. Only then can packaging be skipped. Source bottles remain permanent
in the `cache` release; the seven-day retention applies only to these completed
archive checkpoints. Build jobs need `actions: write` to remove superseded
checkpoints from a retry after their replacement has been uploaded.

ARM and Intel compatibility tests start independently once every selected
variant for their architecture succeeds, downloading the combined variant
artifacts. Publication still waits for all required tests and validates the
complete eight-archive release matrix. Archives use Zstd level 19 and artifact
uploads use compression level 0; already compressed packages are not compressed
again. See [compression measurements](docs/compression.md).

Job summaries and the `workflow-performance` artifact report source-cache
hits/misses, miss reasons, compilation, bottling, uploads, packaging, and runner
queue times. Accumulated work is kept separate from workflow elapsed time.
Partial reruns report only their current attempt's work and elapsed time.
Node HTTP connection failures switch to an independent curl process within the
same bounded retry policy. Upload failures are reported separately from successful
compilation, so a valid PHP archive does not conceal an incomplete source cache.
For a matched cold/warm comparison, pin both tap commits and the workflow ref,
choose an unused `source-bottles-test-*` release, and run twice with `force=true`,
`force-source=true`, `reuse-archives=false`, and `publish=false`. Both runs must
complete the same architecture/variant/test matrix; verify the warm run's cache
hits and runner inputs before comparing timings. Check for unsaved source bottles
and disclose any recovery performed between the runs. A subsequent run with
`reuse-archives=true` checks archive reuse separately.

## Dependencies

- [actions/runner-images](https://github.com/actions/runner-images "GitHub Actions runner images")
- [Homebrew/brew](https://github.com/Homebrew/brew "Homebrew")
- [shivammathur/homebrew-php](https://github.com/shivammathur/homebrew-php "Homebrew PHP tap")
- [shivammathur/homebrew-extensions](https://github.com/shivammathur/homebrew-extensions "Homebrew PHP extensions tap")
- [facebook/zstd](https://github.com/facebook/zstd "Zstandard")
- [jqlang/jq](https://github.com/jqlang/jq "jq")

## License

The code in this project is licensed under the [MIT license](LICENSE).
