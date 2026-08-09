{
  description = "Pi Dash development environment and Linux desktop package";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      piDash = pkgs.callPackage ./nix/package.nix { };
      runtimeCheck = pkgs.runCommand "pi-dash-runtime-check" { } ''
        root="${piDash}/lib/pi-dash"
        runtime="$TMPDIR/runtime"
        mkdir -p "$runtime"

        ROOT="$root" RUNTIME="$runtime" ${pkgs.nodejs_24}/bin/node --input-type=module <<'NODE'
        import fs from "node:fs";
        import { createRequire } from "node:module";
        import { join } from "node:path";

        const root = process.env.ROOT;
        const runtime = process.env.RUNTIME;
        const require = createRequire(join(root, "package.json"));
        const Database = require("better-sqlite3");
        const fsExt = require("fs-ext");
        const pty = require("node-pty");
        await import(join(root, "packages/contracts/dist/index.js"));
        await import(join(root, "packages/pi-extension/dist/index.js"));

        const database = new Database(join(runtime, "native-smoke.sqlite"));
        database.exec("CREATE TABLE smoke (value TEXT); INSERT INTO smoke VALUES ('ok')");
        if (database.prepare("SELECT value FROM smoke").get().value !== "ok") {
          throw new Error("SQLite smoke test failed");
        }
        database.close();

        const lock = fs.openSync(join(runtime, "native-smoke.lock"), "w");
        fsExt.flockSync(lock, "exnb");
        fsExt.flockSync(lock, "un");
        fs.closeSync(lock);

        await new Promise((resolve, reject) => {
          let output = "";
          const terminal = pty.spawn("/bin/sh", ["-c", "printf NIX_PTY_OK"], {
            cols: 80,
            rows: 24,
          });
          terminal.onData((data) => (output += data));
          terminal.onExit(({ exitCode }) => {
            if (exitCode === 0 && output.includes("NIX_PTY_OK")) resolve();
            else reject(new Error("PTY smoke test failed"));
          });
        });
        NODE

        PI_DASH_RESOURCE_ROOT="$root" ${pkgs.nodejs_24}/bin/node \
          "$root/apps/server/dist/migrate-cli.js" \
          --data-dir "$runtime/migrated" \
          --config-dir "$runtime/config" \
          --runtime-dir "$runtime/run"
        test -f "$runtime/migrated/pi-dash.sqlite"
        test ! -e "$root/node_modules/electron"
        cmp ${./LICENSE} "${piDash}/share/licenses/pi-dash/LICENSE"
        touch "$out"
      '';
      piDashApp = {
        type = "app";
        program = "${piDash}/bin/pi-dash";
        meta.description = "Launch Pi Dash";
      };
    in
    {
      packages.${system} = {
        pi-dash = piDash;
        default = piDash;
      };

      apps.${system} = {
        pi-dash = piDashApp;
        default = piDashApp;
      };

      checks.${system} = {
        pi-dash = piDash;
        runtime = runtimeCheck;
      };

      devShells.${system}.default = pkgs.mkShell {
        packages = with pkgs; [
          nodejs_24
          python3
          stdenv.cc
          gnumake
          pkg-config
          git
          electron_43
          chromium
          zenity
          binutils
          xz
        ];

        ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
        ELECTRON_OVERRIDE_DIST_PATH = "${pkgs.electron_43}/bin";
        PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "${pkgs.chromium}/bin/chromium";
        npm_config_nodedir = "${pkgs.nodejs_24}";
      };

      overlays.default = final: _prev: {
        pi-dash = final.callPackage ./nix/package.nix { };
      };

      formatter.${system} = pkgs.nixfmt;
    };
}
