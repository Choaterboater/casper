/**
 * A web page as plain text for the model, with Bun's HTMLRewriter (no new dependency): scripts, styles,
 * menus and frames go, blocks become line breaks, links read "text (url)", entities are decoded and
 * runs of spaces collapse.
 */

const SKIP = "title,script,style,noscript,template,svg,iframe,object,nav,button,select";
const BLOCKS = "p,div,section,article,main,header,footer,aside,li,ul,ol,dl,dt,dd,h1,h2,h3,h4,h5,h6,pre,blockquote,table,tr,td,th,figure,figcaption,details,summary";
const BREAKS = "br,hr";

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", copy: "©", reg: "®", trade: "™",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", bull: "•", middot: "·", deg: "°", times: "×", euro: "€", pound: "£",
};

/** &amp; &#169; &#x27; and the common named entities; anything else stays as written. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

/** Tidy text: no control characters, single spaces, no blank lines. */
export function tidyText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ").replace(/[ \t ]+/g, " ")
    .split("\n").map((line) => line.trim()).join("\n").replace(/\n{2,}/g, "\n").trim();
}

export interface PageText { title: string; text: string }

/** `base` resolves relative links; only http(s) links are written out. */
export async function htmlToText(html: string, base?: string): Promise<PageText> {
  const out: string[] = [];
  let title = "";
  let skip = 0;
  const link = (href: string | null): string | undefined => {
    if (!href || href.startsWith("#")) return undefined;
    try {
      const url = new URL(decodeEntities(href), base);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
    } catch { return undefined; }
  };
  const end = (element: HTMLRewriterTypes.Element, work: () => void) => {
    try { element.onEndTag(work); } catch { work(); }
  };
  await new HTMLRewriter()
    .on("title", { text(chunk) { title += chunk.text; } })
    .on(SKIP, { element(element) { skip++; end(element, () => { skip--; }); } })
    .on(BLOCKS, { element(element) { out.push("\n"); end(element, () => { out.push("\n"); }); } })
    .on(BREAKS, { element() { out.push("\n"); } })
    .on("a[href]", {
      element(element) {
        const url = link(element.getAttribute("href"));
        if (!url) return;
        const start = out.length;
        end(element, () => {
          const words = tidyText(decodeEntities(out.slice(start).join("")));
          if (!skip && words && words !== url) out.push(` (${url})`);
        });
      },
    })
    .onDocument({ text(chunk) { if (!skip) out.push(chunk.text); } })
    .transform(new Response(html))
    .text();
  return { title: tidyText(decodeEntities(title)).slice(0, 300), text: tidyText(decodeEntities(out.join(""))) };
}
