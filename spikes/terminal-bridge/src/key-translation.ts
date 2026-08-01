export const SHIFT_ENTER_SEQUENCE = "\u001b[13;2u";
export const ALT_ENTER_SEQUENCE = "\u001b[13;3u";

export function translateModifiedEnter(event: Pick<KeyboardEvent, "type" | "key" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey">): string | null {
  if (event.type !== "keydown" || event.key !== "Enter" || event.ctrlKey || event.metaKey) return null;
  if (event.shiftKey && !event.altKey) return SHIFT_ENTER_SEQUENCE;
  if (event.altKey && !event.shiftKey) return ALT_ENTER_SEQUENCE;
  return null;
}
