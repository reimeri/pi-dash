export function displayPath(path: string): string {
  return [...path]
    .map((character) => (/[\p{Cc}\p{Cf}]/u.test(character) ? "�" : character))
    .join("");
}
