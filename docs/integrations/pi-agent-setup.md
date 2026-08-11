# Pi agent handoff: configure Pi for Pi Dash

Give this document to a Pi agent that may edit the user's Pi configuration. Do not assume the user has any particular extension names, files, or layout. First discover their effective Pi resources, then add these integrations where applicable at the most appropriate boundary:

1. report an interactive ask-user wait as **blocked**; and
2. keep agents on the branch owned by a Pi Dash-managed worktree.

Pi Dash already supplies its lifecycle/status extension when it launches Pi. Do not install or configure that bundled extension manually.

## Agent instructions

1. Inventory global and current-project resources (`~/.pi/agent/`, `.pi/`, configured `extensions` and `packages`, package manifests, and CLI-loaded extensions). Resolve relative paths from their settings file. Project resources apply only when that project is trusted; a project package entry normally wins over the same global package, while `autoload: false` makes it a delta. CLI extensions are temporary. Use settings, manifests, source, `pi config`, and startup information to distinguish effective resources from merely present or shadowed copies. Use `pi.getAllTools()`/`sourceInfo` only when existing runtime diagnostics expose them; do not create inspection code just for this task. Never print credentials, environment values, or `PI_DASH_STATUS_TOKEN`.
2. Find candidate integration points by behavior, not filename:
   - For blocked status, locate the effective extension that owns the interactive ask-user UI—the code that registers the relevant tool and awaits `ctx.ui` methods or `ctx.ui.custom()`.
   - For branch safety, look for an effective owned extension that augments `before_agent_start`, the system prompt, or Git/PR workflow guidance.
3. Confirm the intended global or project scope. If no interactive ask-user extension exists, do not invent one; report blocked-status integration as not applicable. If no suitable guidance boundary exists, ask approval to create the standalone extension in section 2. If candidates are ambiguous, explain what was found and ask before choosing or copying one.
4. Prefer adding the hooks to the appropriate owned extension. Do not edit Pi-managed npm/git caches; contribute upstream or ask before installing a local copy. If a packaged ask-user extension must be replaced, first verify the local replacement is active, then edit the effective package entry's object-form `extensions` filter with an exact package-root-relative `-path`. Leave unrelated resource keys omitted so they still load; abort if the extension cannot be isolated safely.
5. Preserve unrelated behavior. Before creating a file, check for files and symlinks at the target path. Before changing settings, parse the existing JSON; abort if it is unreadable or malformed, change only the required entry, preserve every other value and file permission, and write safely.
6. Use an existing test harness when available; do not introduce a framework only for this integration. Otherwise reload and perform bounded smoke checks for the acceptance criteria without logging environment values. Verify the loaded provenance after changes, then tell the user to run `/reload` or restart Pi. Do not claim success until the effective paths and checks are verified.

## 1. Wrap the interactive ask-user flow

Instrument only a tool whose purpose is to ask the user and await their answer; its filename and registered tool name may differ from `ask_user`. Do not instrument permission prompts, project trust, settings screens, or unrelated extension dialogs.

Inline this helper in a single-file extension, or place it inside a directory extension whose `index.ts` is the only auto-discovered entry. Do not create a helper as another top-level file under an auto-discovered `extensions/` directory. Adjust import paths and local types only:

```ts
import { randomUUID } from "node:crypto";

interface AttentionEventBus {
  emit(event: string, payload: unknown): void;
}

function emitAttention(
  events: AttentionEventBus,
  phase: "start" | "end",
  interactionId: string,
): void {
  try {
    events.emit("pi-dash:attention", {
      phase,
      interactionId,
      reason: "ask_user",
    });
  } catch {
    // Status reporting must never break the question UI.
  }
}

export async function withPiDashAttention<T>(
  events: AttentionEventBus,
  waitForUser: () => Promise<T>,
): Promise<T> {
  let interactionId: string;
  try {
    interactionId = randomUUID();
  } catch {
    return await waitForUser();
  }

  emitAttention(events, "start", interactionId);
  try {
    return await waitForUser();
  } finally {
    emitAttention(events, "end", interactionId);
  }
}
```

At the interactive call site, after rejecting non-UI modes and completing validation/preflight:

```ts
const result = await withPiDashAttention(pi.events, () =>
  runInteractiveAskUserFlow(/* existing arguments */),
);
```

The event payload must contain only `phase`, a fresh UUID `interactionId`, and the exact reason `ask_user`. The matching `end` must run for answers, cancellation, aborts, timeouts, and thrown errors. Do not include questions, options, answers, tool arguments, session data, or credentials. Do not emit events in print/JSON modes or any path that does not await interactive UI.

## 2. Add managed-worktree guidance

If an owned extension already adds system-prompt or Git/PR guidance, merge the following constants, environment check, and `before_agent_start` behavior into that extension. Otherwise create a small standalone extension in the user-approved scope, such as `~/.pi/agent/extensions/pi-dash-guidance.ts` globally or `.pi/extensions/pi-dash-guidance.ts` for a trusted project. Do not add a second default export to an existing extension file.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const GUIDANCE_MARKER = "<pi_dash_managed_worktree>";

const GUIDANCE = `${GUIDANCE_MARKER}
This session is running in a Pi Dash-managed worktree. Its checked-out branch is part of the managed worktree identity.

- Keep the managed branch checked out for the lifetime of this worktree. Do not create or switch to another branch with git switch, git checkout, or equivalent commands here.
- Before creating a pull request, check whether the current branch already has a pull request for the intended base branch.
- If a matching pull request is open, commit and push the new changes to the same branch so they update that pull request. Update its title or description when the scope changed; do not create a duplicate pull request or a new branch.
- If the prior pull request was merged and the user requests another pull request, continue using the same managed branch. Fetch the intended base, inspect the resulting branch diff, and rebase the clean managed branch onto the latest base only when it preserves the intended follow-up. Then commit, push, and create the new pull request from that same branch.
- If the prior pull request was closed without merging, inspect which prior commits should remain and ask the user before rebasing, rewriting, pushing, or creating another pull request. Keep the managed branch checked out and preserve all local changes.
- Use separate Pi Dash-managed worktrees for independent simultaneous pull requests that require different branches. Never repurpose this worktree by changing its branch.
- If follow-up work already modified this worktree before the pull-request state was known, preserve the changes and branch identity. Do not switch branches or discard, stash, reset, or rewrite work before choosing a safe workflow with the user.
</pi_dash_managed_worktree>`;

function isPiDashManagedEnvironment(env: NodeJS.ProcessEnv): boolean {
  const worktreeId = env.PI_DASH_WORKTREE_ID;
  const runtimeId = env.PI_DASH_RUNTIME_ID;
  const socketPath = env.PI_DASH_STATUS_SOCKET;
  const token = env.PI_DASH_STATUS_TOKEN;
  return Boolean(
    worktreeId &&
    UUID_PATTERN.test(worktreeId) &&
    runtimeId &&
    UUID_PATTERN.test(runtimeId) &&
    socketPath &&
    socketPath.length <= 4_096 &&
    token &&
    token.length >= 32 &&
    token.length <= 512,
  );
}

export default function piDashGuidance(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    if (!isPiDashManagedEnvironment(process.env)) return;
    if (event.systemPrompt.includes(GUIDANCE_MARKER)) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${GUIDANCE}` };
  });
}
```

This extension must remain inert outside a complete Pi Dash runtime environment and must not expose the status token. The marker prevents duplicate prompt injection.

## Acceptance criteria

- During an active Pi Dash agent run, interactive `ask_user` changes the dashboard from **working** to **blocked**, then back to **working** when every exit path finishes.
- Ordinary lifecycle status still works when event emission, UUID generation, or the Pi Dash socket is unavailable.
- Non-interactive ask-user execution emits no attention event.
- In Pi Dash, each agent turn receives the managed-branch guidance exactly once; ordinary Pi sessions do not receive it.
- Blocked-status integration is attached to the discovered effective ask-user extension, or is explicitly reported as not applicable when none exists.
- Managed-worktree guidance is attached to a suitable effective owned extension, or an approved standalone guidance extension is created when no such boundary exists.
- Existing Pi settings, packages, extensions, file permissions, and ask-user behavior remain otherwise unchanged; no managed package cache was edited.
