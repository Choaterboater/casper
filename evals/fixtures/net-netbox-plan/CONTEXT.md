# net-netbox-plan

Compares a source-of-truth device list with a NetBox-style DCIM API and prints what a sync *would*
change. It is a dry run: it must never send anything but `GET`. Tests use a local mock.

## API (subset)

- `GET {baseUrl}/api/dcim/devices/?limit=50` with `Authorization: Token {token}` and `Accept: application/json`.
- Response: `{ "count", "next", "previous", "results": [...] }`; follow `next` (an absolute URL or null).
- A device: `{ "id", "name", "serial", "site": { "slug" }, "role": { "slug" }, "primary_ip4": { "address" } | null }`.
  Servers older than NetBox 3.6 send `device_role` instead of `role`; treat them the same.

## Plan rules

- Match source and NetBox devices by exact `name`. Source names must be unique (else throw).
- Compared fields, in this order: `serial`, `site` (slug), `role` (slug), `primaryIp4` (address with prefix).
  Missing, null and empty-string values are all "no value".
- `create`: source devices missing from NetBox. `update`: matched devices with differences, listing
  only the changed fields as `{ from, to }` (null for "no value"). `unchanged`: names of matched devices
  with no differences. `onlyInNetbox`: names present only in NetBox (reported, never deleted).
  Every list is sorted by name.

## Conventions

- `planSync(options)` in `src/plan.ts` builds the plan; `formatPlan(plan)` in `src/format.ts` prints it.
- `fetch` is injectable. No runtime dependencies.
