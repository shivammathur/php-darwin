# Maintenance

Configuration lives in `conf/`; supported PHP versions and variants are shared by every component.

Runner preparation pins Homebrew sources, preserves the Actions Node runtime, and recovers only proven orphaned builds.

Local tests use temporary fixtures. Native tests run on the configured macOS Actions runners.
