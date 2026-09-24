/** Minimal, attribute-order-independent HTML reader for the acceptance tests. */
export interface Element {
  tag: string;
  attributes: Record<string, string>;
  text: string;
}

export function elements(html: string): Element[] {
  const found: Element[] = [];
  const open = /<([a-z][a-z0-9]*)((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*>([^<]*)/gi;
  for (const match of html.matchAll(open)) {
    const attributes: Record<string, string> = {};
    for (const attribute of match[2]!.matchAll(/([a-z-]+)(?:="([^"]*)")?/gi)) attributes[attribute[1]!.toLowerCase()] = attribute[2] ?? "";
    found.push({ tag: match[1]!.toLowerCase(), attributes, text: match[3]! });
  }
  return found;
}

export const byRole = (html: string, role: string) => elements(html).filter((element) => element.attributes.role === role);
