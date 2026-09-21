/** Shared byte framing only. LSP and DAP retain separate message semantics/lifecycles. */
export class MessageReader {
  private readonly header = Buffer.alloc(8196);
  private headerBytes = 0;
  private body?: Buffer;
  private bodyBytes = 0;
  constructor(private readonly receive: (message: unknown) => void, private readonly maxBytes = 4 * 1024 * 1024) {}
  push(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.body) {
        if (this.headerBytes === this.header.length) throw new Error("Protocol header too large");
        this.header[this.headerBytes++] = chunk[offset++];
        const end = this.headerBytes - 4;
        if (end < 0 || this.header.readUInt32BE(end) !== 0x0d0a0d0a) continue;
        const lengths = this.header.subarray(0, end).toString("ascii").split("\r\n").filter((line) => /^content-length:/i.test(line));
        if (lengths.length !== 1 || !/^content-length: *\d+ *$/i.test(lengths[0])) throw new Error("Invalid protocol frame");
        const size = Number(lengths[0].split(":")[1]);
        if (!Number.isSafeInteger(size) || size <= 0 || size > this.maxBytes) throw new Error("Protocol frame too large");
        this.body = Buffer.alloc(size);
        this.bodyBytes = 0;
        this.headerBytes = 0;
      }
      const length = Math.min(this.body.length - this.bodyBytes, chunk.length - offset);
      chunk.copy(this.body, this.bodyBytes, offset, offset + length);
      this.bodyBytes += length;
      offset += length;
      if (this.bodyBytes === this.body.length) {
        const body = this.body;
        this.body = undefined;
        this.receive(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)));
      }
    }
  }
}
