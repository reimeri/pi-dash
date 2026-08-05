# Agent Guidelines

- Do not consider backwards compatibility. Prefer clean, current designs and remove obsolete paths rather than preserving legacy behavior.
- Avoid allowing legacy cruft, compatibility layers, deprecated APIs, or dead code to accumulate in the codebase.
- Always read and follow `STYLE.md` before touching UI-related code.
- After making changes, bump the application version with `npm run version:bump -- <major|minor|patch>`, choosing the semver component from the scope of the change (breaking / significant feature / fix or small polish). Do not hand-edit version mirrors; the bump script updates root and workspace `package.json` versions, `APP_VERSION`, and the lockfile.
