# net-meraki-export

Exports an organization's device inventory from a Meraki-Dashboard-style REST API to CSV.
Tests run against a local mock; no real API or key is ever used.

## API (the subset this tool uses)

- `GET {baseUrl}/organizations/{orgId}/devices?perPage={n}` with `Authorization: Bearer {apiKey}`.
  Returns a JSON array of devices: `serial`, `name`, `model`, `networkId`, `mac`, `lanIp`, `tags` (array);
  any of them may be missing or null. Other fields are ignored.
- Pagination: the `Link` response header, e.g. `<https://…&startingAfter=Q2XX>; rel=first, <https://…>; rel=next`.
  Follow the `rel=next` URL (quoted or unquoted `rel`) exactly as given until there is none.
- Rate limiting: `429 Too Many Requests` with `Retry-After: <seconds>`. Wait that long and retry the same URL.
  Give up with an error after 5 consecutive 429 retries for one URL. Any other non-2xx response fails the
  export with an error whose message names the status code.

## CSV output

- Header `serial,name,model,networkId,mac,lanIp,tags`, then one row per device sorted by `serial`.
- Missing or null values are empty fields; `tags` are joined with single spaces.
- RFC 4180 quoting (fields with a comma, quote, CR or LF are quoted, embedded quotes doubled);
  every line, including the last, ends with `\n`.

## Conventions

- `exportInventory(options)` in `src/export.ts` returns the CSV text; `fetch` and `sleep` are injectable.
- The CSV writer belongs in `src/csv.ts`.
- No runtime dependencies.
