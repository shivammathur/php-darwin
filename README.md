# PHP Darwin

<a href="https://github.com/shivammathur/php-darwin/actions/workflows/cache-stable.yml" title="PHP Package Cache"><img alt="Build status" src="https://github.com/shivammathur/php-darwin/actions/workflows/cache-stable.yml/badge.svg"></a>
<a href="https://github.com/shivammathur/php-darwin/blob/main/LICENSE" title="license"><img alt="LICENSE" src="https://img.shields.io/badge/license-MIT-428f7e.svg?logo=open%20source%20initiative&logoColor=white&labelColor=555555"></a>
<a href="https://github.com/shivammathur/php-darwin/releases" title="builds"><img alt="PHP Versions Supported" src="https://img.shields.io/badge/php-5.6%20to%208.6-777bb3.svg?logo=php&logoColor=white&labelColor=555555"></a>

> Cache Homebrew PHP packages for fast installation on GitHub Actions macOS runners.

Archives retain runtime/development files and licenses; general documentation, man pages, and info pages are omitted.

## PHP versions

- Stable: PHP 5.6 through PHP 8.5
- Nightly: PHP 8.6
- Variants: NTS and ZTS, debug and release
- Architectures: ARM64 and x86_64

## Labels and tags

| Architecture | Build label | Test labels | Platform tag |
|---|---|---|---|
| ARM64 | `macos-14` | `macos-14`, `macos-15`, `macos-26`, `macos-latest` | `arm64_sonoma` |
| x86_64 | `macos-15-intel` | `macos-15-intel`, `macos-26-intel` | `sequoia` |

Each PHP minor uses a release tag such as `php-8.5`. The release manifest maps a
logical name such as `php_8.5-nts-release+darwin_arm64.tar.zst` to an immutable,
checksum-addressed archive. New patch releases update the manifest without replacing archives in place.

Update checks compare formula source and the bottles usable on the cache build
platforms. Adding bottles for newer macOS versions (including macOS 27) does not
rebuild the shared architecture caches. Full formula hashes remain in the cache
metadata for integrity validation. When no compatible bottle exists, Homebrew
builds from source on the same runner; macOS 14 ARM64 remains the cache minimum
even after its bottles stop being published.

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
extensions use their own source bottles. Assets do not expire. After uploading
and downloading a replacement to verify its checksum, the builder deletes older
package versions for the same architecture, macOS, and PHP variant. It preserves
newer versions uploaded by concurrent runs and different build inputs for the
current version. Cache misses and service outages fall back to source builds.
Build jobs need `contents: write` to maintain this release. Run
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

## Dependencies

- [actions/runner-images](https://github.com/actions/runner-images "GitHub Actions runner images")
- [Homebrew/brew](https://github.com/Homebrew/brew "Homebrew")
- [shivammathur/homebrew-php](https://github.com/shivammathur/homebrew-php "Homebrew PHP tap")
- [shivammathur/homebrew-extensions](https://github.com/shivammathur/homebrew-extensions "Homebrew PHP extensions tap")
- [facebook/zstd](https://github.com/facebook/zstd "Zstandard")
- [jqlang/jq](https://github.com/jqlang/jq "jq")

## License

The code in this project is licensed under the [MIT license](LICENSE).
