{
  lib,
  stdenv,
  buildNpmPackage,
  nodejs_24,
  electron_43,
  python3,
  pkg-config,
  git,
  zenity,
  makeWrapper,
  makeDesktopItem,
  copyDesktopItems,
  autoPatchelfHook,
  binutils,
}:

let
  packageMetadata = lib.importJSON ../package.json;
  source = lib.cleanSourceWith {
    src = ../.;
    filter =
      path: type:
      let
        name = baseNameOf path;
      in
      lib.cleanSourceFilter path type
      && !lib.elem name [
        "node_modules"
        "dist"
        ".release"
        "coverage"
        "playwright-report"
        "test-results"
        ".direnv"
      ];
  };
  desktopItem = makeDesktopItem {
    name = "pi-dash";
    desktopName = "Pi Dash";
    comment = "Local dashboard for the Pi coding agent";
    exec = "pi-dash";
    icon = "pi-dash";
    categories = [ "Development" ];
    terminal = false;
  };
in
buildNpmPackage {
  pname = "pi-dash";
  inherit (packageMetadata) version;
  src = source;

  nodejs = nodejs_24;
  npmDepsHash = "sha256-WFPdr+kgQeHE+NCUu447rp+WIoIZ77nJrys37noP8sY=";
  npm_config_build_from_source = "true";
  npm_config_nodedir = "${nodejs_24}";
  ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

  nativeBuildInputs = [
    python3
    pkg-config
    git
    makeWrapper
    copyDesktopItems
    autoPatchelfHook
    binutils
  ];

  buildInputs = [ stdenv.cc.cc.lib ];
  desktopItems = [ desktopItem ];

  postPatch = ''
    patchShebangs tests/fixtures
  '';

  npmBuildScript = "build";
  doCheck = true;

  checkPhase = ''
    runHook preCheck
    npm run format:check
    npm run lint
    npm run check
    npm test
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall

    runtime="$TMPDIR/pi-dash-runtime"
    mkdir -p \
      "$runtime/apps/server" \
      "$runtime/apps/desktop" \
      "$runtime/apps/web" \
      "$runtime/packages/contracts" \
      "$runtime/packages/pi-extension"

    cp package.json package-lock.json README.md LICENSE "$runtime/"
    cp apps/server/package.json "$runtime/apps/server/"
    cp -r apps/server/dist "$runtime/apps/server/"
    cp -r apps/desktop/dist "$runtime/apps/desktop/"
    cp -r apps/web/dist "$runtime/apps/web/"
    cp packages/contracts/package.json "$runtime/packages/contracts/"
    cp -r packages/contracts/dist "$runtime/packages/contracts/"
    cp packages/pi-extension/package.json "$runtime/packages/pi-extension/"
    cp -r packages/pi-extension/dist "$runtime/packages/pi-extension/"
    cp -r migrations "$runtime/"

    pushd "$runtime"
    npm ci \
      --offline \
      --omit=dev \
      --workspace @pi-dash/server \
      --include-workspace-root=false \
      --no-audit \
      --no-fund

    rm -rf \
      node_modules/better-sqlite3/prebuilds \
      node_modules/better-sqlite3/build \
      node_modules/fs-ext/build \
      node_modules/node-pty/prebuilds \
      node_modules/node-pty/build

    npm rebuild fs-ext node-pty --offline --no-audit --no-fund
    npm run build-release \
      --offline \
      --prefix node_modules/better-sqlite3 \
      --no-audit \
      --no-fund

    preserve_addon() {
      module="$1"
      filename="$2"
      saved="$TMPDIR/$filename"
      cp "$module/build/Release/$filename" "$saved"
      rm -rf "$module/build"
      install -Dm755 "$saved" "$module/build/Release/$filename"
    }

    preserve_addon node_modules/better-sqlite3 better_sqlite3.node
    preserve_addon node_modules/fs-ext fs_ext.node
    preserve_addon node_modules/node-pty pty.node

    rm -rf \
      node_modules/better-sqlite3/prebuilds \
      node_modules/better-sqlite3/deps \
      node_modules/better-sqlite3/src \
      node_modules/better-sqlite3/binding.gyp \
      node_modules/fs-ext/src \
      node_modules/fs-ext/tests \
      node_modules/fs-ext/binding.gyp \
      node_modules/node-pty/prebuilds \
      node_modules/node-pty/third_party \
      node_modules/node-pty/src \
      node_modules/node-pty/binding.gyp

    test ! -e node_modules/electron
    test ! -e node_modules/electron-builder
    test ! -e node_modules/better-sqlite3/prebuilds
    test ! -e node_modules/node-pty/prebuilds

    for workspace in contracts pi-extension; do
      target="$(readlink -f "node_modules/@pi-dash/$workspace")"
      case "$target" in
        "$runtime"/*) ;;
        *)
          echo "Workspace link escapes the staged runtime: $workspace -> $target" >&2
          exit 1
          ;;
      esac
    done

    node --input-type=module --eval '
      await import("better-sqlite3");
      await import("fs-ext");
      await import("node-pty");
      await import("@pi-dash/contracts");
      await import("@pi-dash/pi-extension");
    '

    for addon in \
      node_modules/better-sqlite3/build/Release/better_sqlite3.node \
      node_modules/fs-ext/build/Release/fs_ext.node \
      node_modules/node-pty/build/Release/pty.node
    do
      test -f "$addon"
      if ldd "$addon" | grep -F "not found"; then
        echo "Native addon has unresolved libraries: $addon" >&2
        exit 1
      fi
      patchelf --print-rpath "$addon" >/dev/null
    done
    popd

    mkdir -p "$out/lib" "$out/bin" "$out/share/licenses/pi-dash"
    cp -a "$runtime" "$out/lib/pi-dash"
    install -Dm644 LICENSE "$out/share/licenses/pi-dash/LICENSE"
    install -Dm644 packaging/linux/icon.svg \
      "$out/share/icons/hicolor/scalable/apps/pi-dash.svg"

    makeWrapper ${electron_43}/bin/electron "$out/bin/pi-dash" \
      --add-flags "$out/lib/pi-dash/apps/desktop/dist/main.js" \
      --set PI_DASH_NODE_EXECUTABLE ${nodejs_24}/bin/node \
      --prefix PATH : ${
        lib.makeBinPath [
          git
          zenity
        ]
      }

    runHook postInstall
  '';

  postFixup = ''
    test -x "$out/bin/pi-dash"
    test -f "$out/share/applications/pi-dash.desktop"
    test -f "$out/share/icons/hicolor/scalable/apps/pi-dash.svg"
    test -f "$out/share/licenses/pi-dash/LICENSE"
    cmp LICENSE "$out/share/licenses/pi-dash/LICENSE"
    test ! -e "$out/lib/pi-dash/node_modules/electron"
  '';

  meta = {
    description = "Linux-first local dashboard for the Pi coding agent";
    homepage = "https://github.com/reimeri/pi-dash";
    license = lib.licenses.mit;
    mainProgram = "pi-dash";
    platforms = [ "x86_64-linux" ];
  };
}
