/** RFC 6901 JSON Pointer helpers. */

export function escapeToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function unescapeToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

export function joinPointer(base: string, ...tokens: Array<string | number>): string {
  return base + tokens.map((token) => `/${escapeToken(String(token))}`).join("");
}

/** Renders a pointer the way `$ref` writes it: `#`, `#/properties/name`. */
export function displayPointer(pointer: string): string {
  return `#${pointer}`;
}

export function resolvePointer(root: unknown, pointer: string): unknown {
  if (pointer === "") return root;
  if (!pointer.startsWith("/")) return undefined;

  let current: unknown = root;
  for (const raw of pointer.slice(1).split("/")) {
    const token = unescapeToken(raw);
    if (Array.isArray(current)) {
      current = /^\d+$/.test(token) ? current[Number(token)] : undefined;
    } else if (typeof current === "object" && current !== null) {
      current = (current as Record<string, unknown>)[token];
    } else {
      return undefined;
    }
  }
  return current;
}
