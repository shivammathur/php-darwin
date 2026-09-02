# PHP Darwin

<a href="https://github.com/shivammathur/php-darwin/actions/workflows/cache-stable.yml" title="PHP Package Cache"><img alt="Build status" src="https://github.com/shivammathur/php-darwin/actions/workflows/cache-stable.yml/badge.svg"></a>
<a href="https://github.com/shivammathur/php-darwin/blob/main/LICENSE" title="license"><img alt="LICENSE" src="https://img.shields.io/badge/license-MIT-428f7e.svg?logo=open%20source%20initiative&logoColor=white&labelColor=555555"></a>
<a href="https://github.com/shivammathur/php-darwin/releases" title="builds"><img alt="PHP Versions Supported" src="https://img.shields.io/badge/php-5.6%20to%208.6-777bb3.svg?logo=php&logoColor=white&labelColor=555555"></a>

> Cache Homebrew PHP packages for fast installation on GitHub Actions macOS runners.

## PHP versions

- Stable: PHP 5.6 through PHP 8.5
- Nightly: PHP 8.6
- Variants: NTS and ZTS, debug and release
- Architecture: ARM64

## Labels and tags

| Architecture | Build label | Test labels | Platform tag |
|---|---|---|---|
| ARM64 | `macos-14` | `macos-14`, `macos-15`, `macos-26`, `macos-latest` | `arm64_sonoma` |

Each PHP minor uses a release tag such as `php-8.5`. The release manifest maps a
logical name such as `php_8.5-nts-release+darwin_arm64.tar.zst` to an immutable,
checksum-addressed archive. New patch releases update the manifest without replacing archives in place.

## Dependencies

- [actions/runner-images](https://github.com/actions/runner-images "GitHub Actions runner images")
- [Homebrew/brew](https://github.com/Homebrew/brew "Homebrew")
- [shivammathur/homebrew-php](https://github.com/shivammathur/homebrew-php "Homebrew PHP tap")
- [facebook/zstd](https://github.com/facebook/zstd "Zstandard")
- [jqlang/jq](https://github.com/jqlang/jq "jq")

## License

The code in this project is licensed under the [MIT license](LICENSE).
