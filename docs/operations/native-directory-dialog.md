# Native directory dialog

Pi Dash selects workspace directories through the local daemon. On Linux, the daemon prefers `zenity` and falls back to `kdialog`. It starts either executable directly with an argument array; no shell or generic filesystem-browsing API is involved.

## Prerequisites

- Git must be installed and visible in the daemon's `PATH`.
- A graphical X11 or Wayland session must be available to the daemon through `DISPLAY` or `WAYLAND_DISPLAY`.
- Install `zenity` (recommended) or `kdialog`.
- The daemon must run as the desktop user who owns and can access the repositories.

Only one system picker can be active. A concurrent request receives `DIALOG_BUSY`. Closing the browser request or shutting down the daemon cancels the child picker. Cancelling the picker creates no workspace record.

## Adapter selection

The `nativeDialog` setting accepts:

- `auto` — probe `zenity`, then `kdialog` (default)
- `zenity` — require `zenity`
- `kdialog` — require `kdialog`
- `disabled` — do not launch a native picker

Executables are resolved once from absolute entries in `PATH`. Relative and empty `PATH` entries are ignored. See [configuration](configuration.md) for CLI and environment forms.

## Typed-path recovery

If no supported picker or graphical session is available, the Add Workspace dialog presents an absolute-path field. Typed paths are sent only to the repository inspection endpoint; Pi Dash does not expose directory listing. The daemon canonicalizes the path and verifies it as a usable Git worktree before showing the confirmation step.

## Troubleshooting

| Symptom                                   | Action                                                                                                                                              |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| “No native directory picker is available” | Check `DISPLAY`/`WAYLAND_DISPLAY`, install the selected adapter, and restart the daemon.                                                            |
| Picker opens behind the browser           | Use the desktop task switcher; the Pi Dash progress dialog remains visible until selection or cancellation.                                         |
| `GIT_UNAVAILABLE`                         | Install Git or launch Pi Dash with a `PATH` containing the Git executable.                                                                          |
| `PATH_INACCESSIBLE`                       | Run the daemon as the repository owner and check directory traversal permissions.                                                                   |
| `NOT_A_GIT_WORKTREE`                      | Select a directory inside a non-bare Git worktree. Bare repositories are not workspace roots.                                                       |
| Workspace is degraded after a move        | Restore the repository at its canonical path and retry health, or remove Pi Dash metadata. Paths are never searched for or rewritten automatically. |

Workspace registration, rename, health refresh, and removal do not modify repository files or Git refs. Removal deletes metadata only and is blocked while managed worktree records exist.
