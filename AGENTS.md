# Agent Guidelines

- Do not consider backwards compatibility. Prefer clean, current designs and remove obsolete paths rather than preserving legacy behavior.
- Avoid allowing legacy cruft, compatibility layers, deprecated APIs, or dead code to accumulate in the codebase.
- Always read and follow `STYLE.md` before touching UI-related code.
- After making changes, bump the application version. Choose major, minor, or patch from the scope of the change (breaking / significant feature / fix or small polish). Keep `APP_VERSION` in `packages/contracts` as the source of truth and update matching package metadata and hardcoded version mirrors.
