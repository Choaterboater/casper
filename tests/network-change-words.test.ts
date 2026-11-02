import { expect, test } from "bun:test";
import { describeNetworkChange, RecentObjects, resultJson } from "../src/network/change-words";

/** A network product's writes in plain words: the three real Mist calls of one session, with placeholder ids. */

const ORG = "00000000-0000-0000-0000-000000000000";
const SITE = "00000000-0000-0000-0000-000000000001";
const OLD = "00000000-0000-0000-0000-000000000002";
const NEW = "00000000-0000-0000-0000-000000000003";

const band = (bandwidth: number, extra: Record<string, unknown> = {}) => ({ ant_gain: 0, disabled: false, allow_rrm_disable: false,
  power_min: 3, power_max: 11, power: null, channels: null, bandwidth, ...extra });
const template = (name: string, width5: number) => ({ name, country_code: "US", band_24_usage: "24", band_24: band(20, { preamble: "short" }),
  band_5: band(width5, { antenna_beam_pattern: "wide" }), band_6: band(80, { antenna_beam_pattern: "wide" }), ant_gain_5: 0, ant_gain_6: 0,
  ant_gain_24: 0, model_specific: {} });

test("a new RF template copied from one read this session says what it copies and what differs", () => {
  const recent = new RecentObjects();
  recent.remember({ content: [{ type: "text", text: JSON.stringify({ ...template("Standard-RF", 40), id: OLD, org_id: ORG, modified_time: 1 }) }] });
  const words = describeNetworkChange("mist_create_org_rf_template", { org_id: ORG, body: template("Standard-RF-80MHz", 80) }, { recent });
  expect(words).toEqual({
    product: "Mist",
    box: "Create RF template Standard-RF-80MHz (a copy of Standard-RF; 5 GHz width 40 → 80 MHz)",
    after: "created RF template Standard-RF-80MHz (a copy of Standard-RF; 5 GHz width 40 → 80 MHz)",
    undo: "delete RF template Standard-RF-80MHz",
  });
});

test("a new RF template with nothing read to compare says its key settings", () => {
  const words = describeNetworkChange("mist_create_org_rf_template", { org_id: ORG, body: template("Standard-RF-80MHz", 80) });
  expect(words?.box).toBe("Create RF template Standard-RF-80MHz (2.4 GHz width 20 MHz, 5 GHz width 80 MHz, 6 GHz width 80 MHz)");
});

test("a site's RF template change names both templates and how to set it back", () => {
  const recent = new RecentObjects();
  recent.remember({ content: [{ type: "text", text: JSON.stringify([{ id: OLD, name: "Standard-RF" }, { id: NEW, name: "Standard-RF-80MHz" }]) }] });
  const args = { site_id: SITE, body: { name: "Lab-Site", rftemplate_id: NEW } };
  expect(describeNetworkChange("mist_update_site_info", args, { recent, before: { name: "Lab-Site", rftemplate_id: OLD } })).toEqual({
    product: "Mist",
    box: "Set site Lab-Site's RF template to Standard-RF-80MHz (now Standard-RF)",
    after: "site Lab-Site now uses RF template Standard-RF-80MHz (was Standard-RF)",
    undo: "set it back to Standard-RF",
  });
  // Nothing read before: the new template by name, no undo Casper can't back up.
  expect(describeNetworkChange("mist_update_site_info", args, { recent })).toEqual({
    product: "Mist", box: "Set site Lab-Site's RF template to Standard-RF-80MHz", after: "site Lab-Site now uses RF template Standard-RF-80MHz",
  });
  // No name anywhere: the id, short.
  expect(describeNetworkChange("mist_update_site_info", { site_id: SITE, body: { rftemplate_id: NEW } })?.after)
    .toBe("site 00000000… now uses RF template 00000000…");
});

test("running the channel plan says which band and where", () => {
  const recent = new RecentObjects();
  recent.remember({ structuredContent: { result: { id: SITE, name: "Lab-Site", timezone: "UTC" } } });
  expect(describeNetworkChange("mist_optimize_site_rrm", { site_id: SITE, body: { bands: ["5"] } }, { recent })).toEqual({
    product: "Mist",
    box: "Run the radio channel plan (RRM) on 5 GHz at site Lab-Site",
    after: "ran the 5 GHz radio channel plan (RRM) at site Lab-Site",
  });
});

test("other writes read from the tool's name; a plain setting change says what it was", () => {
  expect(describeNetworkChange("mist_delete_org_wlan", { org_id: ORG, wlan_id: NEW })?.box).toBe("Delete WLAN 00000000…");
  expect(describeNetworkChange("central_update_site_setting", { site_id: SITE, body: { timezone: "America/Chicago" } }, { before: { timezone: "UTC" } }))
    .toEqual({ product: "Central", box: "Update site settings at site 00000000…: timezone America/Chicago (now UTC)",
      after: "updated site settings at site 00000000…: timezone America/Chicago (was UTC)", undo: "set timezone back to UTC" });
  // Not a network product's tool: no words, the generic row stays.
  expect(describeNetworkChange("set_ssid", { ssid: "corp" })).toBeUndefined();
});

test("a result's JSON is read from its structured content or its text", () => {
  expect(resultJson({ structuredContent: { a: 1 } })).toEqual({ a: 1 });
  expect(resultJson({ content: [{ type: "text", text: "{\"b\":2}" }] })).toEqual({ b: 2 });
  expect(resultJson({ content: [{ type: "text", text: "not json" }] })).toBeUndefined();
});
