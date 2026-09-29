import { expect, test } from "bun:test";
import { indexWords, suggestField, termScore, termVariants, tokenize } from "../src/capabilities/search";

function matches(a: string, b: string): boolean {
  const other = new Set(termVariants(b));
  return termVariants(a).some((variant) => other.has(variant));
}

test("tokenize keeps the broker's old word rules", () => {
  expect(tokenize("Please show the Mist_List_Sites tool for a VLAN")).toEqual(["mist", "list", "sites", "vlan"]);
  expect(tokenize("*")).toEqual([]);
  expect(tokenize("site site SITE")).toEqual(["site"]);
});

test("plural and singular names meet without a lookup table", () => {
  for (const [a, b] of [["site", "sites"], ["policy", "policies"], ["switch", "switches"], ["alias", "aliases"],
    ["status", "statuses"], ["ap", "aps"], ["area", "areas"], ["vlan", "vlans"], ["router", "routers"], ["device", "devices"]] as const) {
    expect(matches(a, b)).toBe(true);
    expect(matches(b, a)).toBe(true);
  }
});

test("near words that are not plurals do not match", () => {
  expect(matches("class", "clas")).toBe(false);
  expect(matches("vlan", "van")).toBe(false);
  expect(matches("vlans", "van")).toBe(false);
  expect(termVariants("class")).toEqual(["class"]);
  expect(termVariants("as")).toEqual(["as"]);
});

test("termScore: name beats description, prefix only when asked and only for 5+ letters", () => {
  const name = indexWords("mist_list_sites mist");
  const desc = indexWords("Lists every site in the organization");
  expect(termScore("site", name, desc)).toBe(4);
  expect(termScore("organizations", name, desc)).toBe(1);
  expect(termScore("vlan", name, desc)).toBe(0);

  const junosName = indexWords("get_junos_configuration junos");
  const empty = new Set<string>();
  expect(termScore("config", junosName, empty)).toBe(0);
  expect(termScore("config", junosName, empty, { prefix: true })).toBe(2);
  // Four letters is too short for the prefix rule.
  expect(termScore("conf", junosName, empty, { prefix: true })).toBe(0);
  expect(termScore("junos", junosName, empty, { prefix: true })).toBe(4);
});

test("suggestField finds the field the caller most likely meant", () => {
  expect(suggestField("router", ["router_name", "command"])).toBe("router_name");
  expect(suggestField("stie", ["site", "limit"])).toBe("site");
  expect(suggestField("siteName", ["site_id", "org_id"])).toBe("site_id");
  expect(suggestField("hostnames", ["hostname", "port"])).toBe("hostname");
  expect(suggestField("banana", ["site", "limit"])).toBeUndefined();
  expect(suggestField("id", ["os"])).toBeUndefined();
  expect(suggestField("", ["site"])).toBeUndefined();
  expect(suggestField("x".repeat(500), ["x".repeat(500)])).toBeUndefined();
  expect(suggestField("site", [])).toBeUndefined();
});
