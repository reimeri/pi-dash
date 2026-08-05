# Install on Linux

Pi Dash currently publishes a portable Linux x64 tarball. It contains Electron, a pinned Node.js 24.18.0 sidecar runtime, the production server and UI, migrations, the Pi status extension, and native dependencies built for Linux x64. A system Node installation is not used by the packaged application.

## Requirements

- 64-bit glibc-based Linux; musl distributions are not currently supported
- Linux kernel 4.18 or newer, glibc 2.31 or newer, and a libstdc++ providing `GLIBCXX_3.4.28`
- A graphical desktop session supported by Electron
- Git
- Pi 0.83.0 or newer
- `zenity` or `kdialog` for native directory selection; typed-path entry remains available without either picker

The initial portable artifact has not yet completed a distribution compatibility matrix. Do not infer support for a distribution solely from the minimum runtime versions above. This private artifact is marked `UNLICENSED`; do not redistribute it publicly until first-party licensing and the third-party notice inventory are completed.

## Verify and extract

Download the tarball and `SHA256SUMS` into one directory, then run:

```sh
sha256sum --check SHA256SUMS --ignore-missing
tar -xzf pi-dash-0.1.1-linux-x64.tar.gz
```

Run the `pi-dash` executable from the extracted directory. The executable may be launched from any current working directory; all immutable resources are resolved from the application installation.

The portable tarball does not install a desktop entry. A package-manager-integrated artifact will be added separately after the portable release is validated. `SHA256SUMS` detects corruption but is not a signature; provenance depends on obtaining both files through a trusted channel.

## Data and upgrades

Application data is not stored in the extracted directory. By default it remains in:

- data and managed worktrees: `$XDG_DATA_HOME/pi-dash`, or `~/.local/share/pi-dash`
- configuration: `$XDG_CONFIG_HOME/pi-dash`, or `~/.config/pi-dash`
- runtime files: `$XDG_RUNTIME_DIR/pi-dash`, with a data-directory fallback
- logs: `$XDG_STATE_HOME/pi-dash`, or `~/.local/state/pi-dash`

To upgrade, stop Pi Dash, verify and extract the new artifact, then launch the new executable. Existing XDG data is retained. The daemon creates and verifies a SQLite backup before applying forward migrations.

Do not replace files inside an extracted application while it is running.

## Uninstall

Stop Pi Dash and remove only the extracted application directory. This intentionally leaves XDG data, managed worktrees, Git repositories, and Pi configuration/sessions intact.

Data removal is a separate manual operation. Review all paths above and reconcile managed Git worktrees before deleting them.

## Build the artifact

A release build requires Linux x64, Node.js 24+, npm, Git, and Podman or Docker. The container build needs network access to the pinned Node base image and the official Node.js, Electron, and npm dependency downloads:

```sh
npm ci
npm run package:linux
npm run verify:linux-artifact
```

Outputs are written under `dist/`:

```text
pi-dash-<version>-linux-x64.tar.gz
SHA256SUMS
```

The build uses the digest-pinned Node 24.18.0 Bullseye image as its compiler and glibc baseline. It downloads the pinned official Node.js sidecar archive and checks its fixed SHA-256 before use. Native addons are rebuilt from source in a clean staging tree, then rejected if they require newer symbols than `GLIBC_2.31` or `GLIBCXX_3.4.28`.

`verify:linux-artifact` validates archive paths and links before extraction, executable modes, first-party `UNLICENSED` metadata, forbidden state/log/database files, selected secret patterns, ELF architecture and symbol floors, SQLite migrations, an actual PTY, and an `fs-ext` lock operation.
