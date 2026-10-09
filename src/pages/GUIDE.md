How to build a good Casper page

- One self-contained HTML file: `<!doctype html>`, `<meta charset="utf-8">`, `<meta name="viewport" content="width=device-width, initial-scale=1">` and a short `<title>`. CSS in `<style>`, JS in `<script>`. No build step and no other local files.
- The page can't fetch from other sites: fetch, forms and outside images are blocked, and so are cookies, localStorage and WebRTC (the page has an origin of its own). Keep state in variables. Put the data in the page (a JS object, a table, inline SVG). Add a library only when it earns its place, from cdn.jsdelivr.net, cdnjs.cloudflare.com or unpkg.com with an exact version (chart.js@4.4.1, mermaid@11.4.1). Fonts: system fonts, or Google Fonts.
- Light and dark: colours as CSS variables on `:root`, set again in `@media (prefers-color-scheme: dark)`; give `body` its own background and text colour.
- Phone width: it works at 360 px with no sideways scroll, with 16 px side margins; a wide table scrolls inside its own box.
- Lead with the answer (the pick, the key number, the one thing to look at), then the detail. Plain words, short labels.
- Real data from the work, never invented numbers; say where a number came from. Label every chart's axes and units, and don't rely on colour alone.
- A comparison: one column per option, the same rows for each, the recommended one marked and why. A mock-up: real wording, not lorem ipsum. A diagram: inline SVG with text labels. A report for others: a title, the date, a summary first.
- Keep private things out: no secrets, keys, tokens or passwords, and no file contents beyond what the user asked to see.
- A Mermaid diagram in the terminal (the diagram tool) is enough when the user doesn't need it in the browser.
- Same name again replaces the page and the open tab reloads itself, so improve it in place rather than making a new one.
