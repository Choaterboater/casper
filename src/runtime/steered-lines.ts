import type { Message } from "@earendil-works/pi-ai";

/** The conversation's record that a user message is a line the person typed during work (its timestamp). */
export const STEERED_LINE_ENTRY = "casper.steered-line";
/** What the model reads before a line typed during work. Without it a model takes the newest user message as its new
 * task: a quick question in the middle of a build ("how many cards do I have?") was answered and the build ended. */
export const STEERED_NOTE = "[Typed while you work: answer it or act on it, then carry on with the task you were doing unless this says to stop or change it.]";

/** A saved record's time, or undefined when the record is not one. */
export function steeredAt(data: unknown): number | undefined {
  const at = data && typeof data === "object" ? (data as { at?: unknown }).at : undefined;
  return typeof at === "number" && Number.isSafeInteger(at) && at >= 0 ? at : undefined;
}

const textOf = (message: Extract<Message, { role: "user" }>): string => typeof message.content === "string" ? message.content
  : message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");

/** A provider-only projection, like the tool history's: the transcript, the waiting rows, ↑ and the saved conversation
 * keep the person's words. Pi gives a line typed during work no mark, so a line is known by its words and by arriving
 * after Casper queued it; once known, its time is saved and every later request sends the same bytes. */
export class SteeredLines {
  private readonly queued: Array<{ text: string; at: number }> = [];

  /** Casper is handing this line to Pi's queue now. */
  sent(text: string, at = Date.now()): void { this.queued.push({ text, at }); }

  /** Pi's queue was emptied (taken back, or the task ended): those lines never reach the model as typed lines. */
  cleared(): void { this.queued.length = 0; }

  /** The request's messages with the note before each typed line: the ones saved earlier (`known`) and the queued ones
   * that just arrived, which go to `record` so the conversation remembers them. */
  project(messages: Message[], known: ReadonlySet<number>, record: (at: number) => void): Message[] {
    const marked = new Set(known);
    for (const message of messages) {
      if (message.role !== "user" || !Number.isSafeInteger(message.timestamp) || marked.has(message.timestamp)) continue;
      const text = textOf(message);
      const index = this.queued.findIndex(line => line.text === text && message.timestamp >= line.at);
      if (index < 0) continue;
      this.queued.splice(index, 1);
      marked.add(message.timestamp);
      record(message.timestamp);
    }
    if (!marked.size) return messages;
    return messages.map(message => message.role !== "user" || !marked.has(message.timestamp) ? message : {
      ...message,
      content: [{ type: "text" as const, text: STEERED_NOTE }, ...typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content],
    });
  }
}
