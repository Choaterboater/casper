# 99. MCP images reach the model

Date: 2026-11-09. Status: proposed. Changes how decision 12 (old tool output is hidden only in provider requests)
treats MCP results, and the MCP rule "binary content is left out". Until now Casper dropped every `image` block an
MCP server returned and left `binary MCP content is not exposed` in its place. A server that draws a site map, takes a
screenshot or renders a chart gave the AI nothing to look at. Claude Code and DeepSeek Harness both pass an MCP picture
to a model that declares image input, and DeepSeek Harness drops the pictures of an `isError` result, as Casper now does.

## Decision

- **Pictures go to the model.** In the AI's own MCP tools (`call_capability` and the direct `mcp_…` tools), an
  `image` block whose bytes are a PNG, JPEG, GIF or WebP is taken out of the result and sent after its text, as
  `RuntimeToolResult.images`, the way the browser's screenshots are (`src/capabilities/pictures.ts`). Every server,
  as in Claude Code and DeepSeek Harness. Its place in the text keeps one line: `{ type: "image", mimeType, picture: N }`,
  plus the shrink note when it was shrunk. The summary adds `1 picture follows this result.`
- **The limits are the ones Casper already has.** At most `MAX_IMAGES` (8) pictures per result and `MAX_IMAGE_BYTES`
  (20 MB) each, the same as a request's pasted or dropped pictures (`src/app/images.ts`). Then each is shrunk the way
  Pi's `read` and the browser's screenshots are (`src/pictures/fit.ts`: at most 2000 px and 4.5 MB of base64). A
  picture past a limit, or one that can't be made small enough, stays out with a line that says why:
  `picture left out: at most 8 per result`, `over 20 MB`, `too large to send`. No new limit is added.
- **Two differences from DeepSeek Harness.** Both read the picture's own bytes. DeepSeek Harness refuses a picture
  whose declared type does not match them; Casper sends it as its bytes say (`imageMimeType`): a PNG a server calls
  `image/jpeg` goes as a PNG, and text or an SVG that calls itself a PNG stays out. And Casper hides old MCP pictures
  after the latest rounds under **Hide old tool output** (below), where DeepSeek Harness keeps them in later requests
  until one goes over the model's picture budget, then puts a placeholder in place of the oldest.
- **On, with an off switch.** `mcp_pictures: on | off` in `~/.casper/config.yaml` only (a profile or project is
  refused), on by default, shown in /settings as **MCP pictures** in the MCP area. Off: every picture keeps today's
  note and nothing is shrunk, read at each call, so a change applies from the next step.
- **A model that can't see images** gets today's note in each picture's place, never the picture. Pi tells the
  tool which model the call answers (`RuntimeToolContext.seesImages`), so no time goes on shrinking pictures that
  model would never get. Should a picture still reach `toolContent` in `src/runtime/pi.ts`, that model gets
  `Picture not attached: this model can't see images.` instead, as for every tool.
- **Still left out, with today's note:** audio, resource blobs, an image block that is not one of those four types
  (an SVG, a TIFF), every picture in a result the server marked `isError` (the failure's text is what the AI needs),
  and the reader's own MCP calls (its separate model call reads text).
- **Tokens.** A picture is sent again with every later request, as a pasted one is. So **Hide old tool output**
  (decision 12) now also hides old MCP pictures, the way it hides a browser check's: the result's text always stays,
  the stub reads `[pictures of <tool> hidden, re-run only if safe to see it]`, and the latest four rounds and a
  picture the conversation still refers to stay. A text-only MCP result is never hidden, as before.
- **Time.** Taking a picture adds one shrink step: tens of milliseconds for a small one, about a second for a 4K
  screenshot. The pictures of one result shrink at the same time, each in its own worker, so 8 large ones take about
  as long as the slowest, not 8 seconds. Stop ends the wait at once: the call already ran, so its result still comes
  back, and a picture not yet shrunk stays out with `picture left out: stopped`. The first picture in a session also
  loads Pi's image code. The pictures are taken out before the secret scrub, so the scrub no longer reads megabytes
  of base64.

## Guard rails

- The picture's bytes never enter the JSON text, so the 16 KiB result budget, lists, cursors and previews behave as
  before.
- The scrub still reads every text block and the picture's metadata. Base64 has no text a scrub could match, and
  Casper can't read text drawn in a picture, so a secret shown in a picture reaches a model that sees images. This is
  the same as a picture the AI reads with `read` or a page it screenshots. A change to secrets handling: owner's
  review.
- Only you turn pictures off (`mcp_pictures`); a project or profile can't. With it on, a model that sees images gets
  what the server sent, within the limits above. **Hide old tool output** off keeps every old picture, as it keeps
  every old read.

## A finding

A picture's base64 in the result text; more than 8 pictures, or one over 20 MB, sent; a picture sent to a model
without image input, or shrunk for one; a picture sent or shrunk with `mcp_pictures: off`; a type taken from the
declared `mimeType` instead of the bytes; a picture from an `isError` result or the reader's call sent; audio or a blob sent; an MCP
result's text hidden.
