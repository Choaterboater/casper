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
  `picture left out: at most 8 per result`, `over 20 MB`, or
  `<tool>'s picture (<W>x<H> px, <N> KB) was not sent: it could not be shrunk to 2000 px and 4.5 MB`.
- **Sizes are read before a picture is opened.** A small file can unpack to gigabytes, and up to 8 decode at once.
  So the width and height come from the picture's header first (`headerSize` in `src/pictures/header.ts`). Each is
  at least the size a decoder makes room for, so a header that could hide a bigger one is malformed and gives no size:
  - PNG: IHDR's, and IHDR must be the first chunk, 13 bytes long.
  - JPEG: the first SOFn's, after skipping any 0xFF fill bytes before each marker. Every segment up to and with the
    frame must fit in the file, and a marker with no length before the frame is malformed.
  - GIF: a decoder makes room for the first frame at its image descriptor's size, which may be bigger than the
    logical screen. So Casper walks past the global colour table and any extension blocks to that descriptor, and
    takes the larger of the screen and the frame for each side (a real GIF whose frame overflows its screen still
    opens). No frame, or a file cut short before it, gives no size.
  - WebP: a simple one's VP8 or VP8L bitstream size. An extended one (VP8X) says a canvas, but a decoder opens its
    first frame's own bitstream at full size, then crops it. So the first VP8, VP8L or ANMF frame after it is read
    too (chunks walked inside the file, with an odd-sized one's pad byte), and the canvas counts only when that frame
    is within it.

  One over 16384 px a side or 40 megapixels, or one whose size can't be read, is never decoded and stays out with
  `<tool>'s picture (…) was not opened: over 16384 px a side or 40 megapixels` (or `its size could not be read`).
  This is the one limit added beyond a request's own: a pasted picture comes from you, an MCP picture from a server.
  A saved picture's web size (`webSize`, used by `make_picture`) keeps main's looser reading (`pictureSize` in
  `src/pictures/shrink.ts`): there a size only decides whether sips or ImageMagick shrinks the picture.
- **A broken picture stays out; never sent unshrunk past 2000 px.** Pi's resize gives nothing both when no image
  library loads and when it can't decode the body (it catches every error), so when it gives nothing Casper checks
  once whether the library loads by resizing a 1x1 PNG (`imageLibraryLoads`). It loads: the library could not open
  this picture, which stays out with `<tool>'s picture (…) was not sent: it could not be opened`, since a provider
  usually refuses the whole request over a broken picture. It doesn't load: the picture goes as it is only when its
  header says it is already within 2000 px and 4.5 MB of base64; otherwise it stays out with the `was not sent` line
  above. The browser's screenshots are Casper's own and keep their rule (`fitPicture` in `src/browser/tools.ts`):
  not resized, one under 4.5 MB of base64 goes as it is.
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

A picture's base64 in the result text; more than 8 pictures, or one over 20 MB, sent; a picture decoded whose header
says over 16384 px a side or 40 megapixels, or has no size (a GIF's or WebP's first frame counted); a picture sent unshrunk whose header says over 2000 px; a
picture the image library loaded and could not open sent; a
picture sent to a model without image input, or shrunk for one; a picture sent or shrunk with `mcp_pictures: off`; a
type taken from the declared `mimeType` instead of the bytes; a picture from an `isError` result or the reader's call
sent; audio or a blob sent; an MCP result's text hidden.
