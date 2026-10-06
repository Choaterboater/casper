import { useState, type FormEvent } from "react";

type Answer = { kind: "empty" } | { kind: "ok"; text: string } | { kind: "error"; text: string };

export function APITester() {
  const [answer, setAnswer] = useState<Answer>({ kind: "empty" });
  const [busy, setBusy] = useState(false);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const method = String(form.get("method"));
    const url = new URL(String(form.get("endpoint")), location.href);
    setBusy(true);
    try {
      const response = await fetch(url, { method });
      const body = JSON.stringify(await response.json(), null, 2);
      setAnswer(response.ok ? { kind: "ok", text: body } : { kind: "error", text: `${response.status}: ${body}` });
    } catch (error) {
      setAnswer({ kind: "error", text: String(error) });
    } finally {
      setBusy(false);
    }
  }

  const field = "min-h-11 rounded border border-line bg-surface px-3 text-base text-ink";

  return (
    <section className="flex flex-col gap-4">
      <form onSubmit={send} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex flex-col gap-1">
          <label htmlFor="method" className="text-sm font-medium">Method</label>
          <select id="method" name="method" className={field}>
            <option value="GET">GET</option>
            <option value="PUT">PUT</option>
          </select>
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <label htmlFor="endpoint" className="text-sm font-medium">Address</label>
          <input id="endpoint" name="endpoint" type="text" defaultValue="/api/hello" className={`${field} font-mono`} />
        </div>
        <button
          type="submit"
          disabled={busy}
          className="min-h-11 cursor-pointer rounded bg-accent px-5 font-medium text-accent-ink hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60"
        >
          {busy ? "Sending…" : "Send"}
        </button>
      </form>

      <div aria-live="polite">
        {answer.kind === "empty" && <p className="text-muted">No answer yet. Send a request to see it here.</p>}
        {answer.kind === "ok" && (
          <pre className="overflow-x-auto rounded border border-line bg-surface p-3 font-mono text-sm">{answer.text}</pre>
        )}
        {answer.kind === "error" && (
          <p role="alert" className="rounded border border-danger p-3 text-danger">
            That didn't work: {answer.text}
          </p>
        )}
      </div>
    </section>
  );
}
