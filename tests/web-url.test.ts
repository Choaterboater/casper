import { expect, test } from "bun:test";
import { NotExecutedError } from "../src/capabilities/result";
import { publicAddress, resolvePublic, webTarget } from "../src/web/url";

test("every private, local and metadata range is refused; public addresses pass", () => {
  for (const ip of ["0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.5.4", "172.31.255.255", "192.168.1.1",
    "198.18.0.1", "224.0.0.1", "240.0.0.1", "255.255.255.255", "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "64:ff9b::a00:1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "0:0:0:0:0:ffff:10.0.0.1", "[::1]", "not an ip"]) {
    expect(publicAddress(ip)).toBe(false);
  }
  for (const ip of ["93.184.215.14", "1.1.1.1", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) expect(publicAddress(ip)).toBe(true);
});

test("addresses: http and https only, no password, ports 80 and 443 only, http upgraded, fragment dropped", () => {
  expect(webTarget("http://docs.example.com/a?b=1#top").href).toBe("https://docs.example.com/a?b=1");
  expect(webTarget("http://docs.example.com:80/").href).toBe("https://docs.example.com/");
  expect(webTarget("https://docs.example.com:443/x").href).toBe("https://docs.example.com/x");
  expect(() => webTarget("https://user:pw@docs.example.com/")).toThrow(NotExecutedError);
  expect(() => webTarget("https://user@docs.example.com/")).toThrow("user name or password");
  expect(() => webTarget("https://docs.example.com:8080/")).toThrow("only ports 80 and 443");
  expect(() => webTarget("file:///etc/passwd")).toThrow("only http and https");
  expect(() => webTarget("ftp://example.com/")).toThrow("only http and https");
  expect(() => webTarget("not a url")).toThrow(NotExecutedError);
  expect(() => webTarget(`https://example.com/${"a".repeat(2100)}`)).toThrow("2048");
  // A redirect may not go down to plain http.
  expect(() => webTarget("http://docs.example.com/", false)).toThrow("https to plain http");
});

test("a name must resolve only to public addresses; IP literals and local names are checked without DNS", async () => {
  const dns = (answers: Record<string, string[]>) => async (host: string) => (answers[host] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 as const : 4 as const }));
  expect(await resolvePublic("docs.example.com", dns({ "docs.example.com": ["93.184.215.14"] }))).toEqual({ address: "93.184.215.14", family: 4 });
  await expect(resolvePublic("mixed.example.com", dns({ "mixed.example.com": ["93.184.215.14", "10.0.0.5"] }))).rejects.toThrow("private or local address (10.0.0.5)");
  await expect(resolvePublic("rebind.example.com", dns({ "rebind.example.com": ["::ffff:127.0.0.1"] }))).rejects.toThrow(NotExecutedError);
  await expect(resolvePublic("missing.example.com", dns({}))).rejects.toThrow("could not be found");
  let asked = 0;
  const counting = async () => { asked++; return [{ address: "93.184.215.14", family: 4 as const }]; };
  for (const host of ["169.254.169.254", "127.0.0.1", "[::1]", "::ffff:127.0.0.1", "localhost", "app.localhost", "printer.local", "intranet"]) {
    await expect(resolvePublic(host, counting)).rejects.toThrow(NotExecutedError);
  }
  expect(asked).toBe(0);
  // URL parsing turns decimal and hex spellings into dotted form first.
  expect(webTarget("http://2130706433/").hostname).toBe("127.0.0.1");
  expect(webTarget("http://0x7f.1/").hostname).toBe("127.0.0.1");
});
