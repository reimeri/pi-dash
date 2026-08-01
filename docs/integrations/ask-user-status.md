# Ask-user workflow status integration

Pi Dash reports blocked only when an interactive extension cooperates through Pi's shared event bus. This avoids treating tool preflight or a model-written question as an actual terminal UI wait.

A compatible ask-user implementation must emit `pi-dash:attention` start immediately before awaiting terminal UI and matching end in `finally`:

```ts
import { randomUUID } from "node:crypto";

const interactionId = randomUUID();
pi.events.emit("pi-dash:attention", {
  phase: "start",
  interactionId,
  reason: "ask_user",
});
try {
  return await ctx.ui.custom(/* interactive UI */);
} finally {
  pi.events.emit("pi-dash:attention", {
    phase: "end",
    interactionId,
    reason: "ask_user",
  });
}
```

Rules:

1. Emit start only after validation and preflight, at the actual UI-await boundary.
2. Use a fresh UUID per interaction.
3. The only supported reason in protocol v1 is `ask_user`.
4. Always emit end in `finally`, covering answer, cancel, abort, timeout, and thrown errors.
5. End only the interaction ID created by that call. Overlapping calls are supported.
6. Do not include question text, options, answers, tool arguments, session content, or credentials in the event.
7. Do not emit waits in print/JSON modes where no terminal UI is awaited.

`tests/fixtures/compatible-ask-user-extension.ts` is the executable reference wrapper. Incompatible or absent extensions remain fully functional; Pi Dash simply shows working rather than guessing blocked.
