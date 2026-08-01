import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";

async function ask(ctx: ExtensionCommandContext): Promise<string | undefined> {
  const selected = await ctx.ui.select("Spike ask-user fixture", [
    "1. Use the suggested answer",
    "2. Type a free-text answer",
  ]);
  if (selected === "2. Type a free-text answer") {
    return ctx.ui.input("Spike free-text answer", "Type Unicode or multiline paste here");
  }
  return selected;
}

export default function askUserFixture(pi: ExtensionAPI) {
  pi.registerCommand("spike-ask", {
    description: "Open the terminal bridge ask-user selector and optional free-text input",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") return;
      const interactionId = randomUUID();
      pi.events.emit("pi-dash:attention", {
        phase: "start",
        interactionId,
        reason: "ask_user",
      });
      try {
        const answer = await ask(ctx);
        ctx.ui.notify(answer ? `Spike answer: ${answer}` : "Spike ask-user cancelled", "info");
      } finally {
        pi.events.emit("pi-dash:attention", {
          phase: "end",
          interactionId,
          reason: "ask_user",
        });
      }
    },
  });
}
