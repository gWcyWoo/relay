import assert from "node:assert/strict";
import { test } from "node:test";
import { formatToken, lanCandidates, parseToken } from "../src/peering.ts";

test("tokens are secret@host:port and nothing else", () => {
  assert.deepEqual(parseToken("k8f3ab2c@192.168.1.5:8765"), { secret: "k8f3ab2c", host: "192.168.1.5", port: 8765 });
  assert.equal(formatToken("k8f3ab2c", { host: "192.168.1.5", port: 8765 }), "k8f3ab2c@192.168.1.5:8765");
  for (const bad of ["garbage", "k8f3@host", "@host:1", "k8f3@host:port", "a b@host:1"]) {
    assert.throws(() => parseToken(bad), new RegExp(`Malformed token "${bad}": expected secret@host:port`));
  }
});

test("LAN candidates put the default-route interface first, then en/eth/wl, then tunnels; loopback excluded", () => {
  const interfaces = {
    lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    utun4: [{ address: "100.113.129.24", family: "IPv4", internal: false }],
    en1: [{ address: "10.0.0.7", family: "IPv4", internal: false }],
    en0: [
      { address: "fe80::1", family: "IPv6", internal: false },
      { address: "192.168.0.111", family: "IPv4", internal: false },
    ],
    utun1024: [{ address: "198.18.0.1", family: "IPv4", internal: false }],
  } as unknown as Parameters<typeof lanCandidates>[0];
  assert.deepEqual(lanCandidates(interfaces, "en0"), ["192.168.0.111", "10.0.0.7", "100.113.129.24", "198.18.0.1"]);
  assert.deepEqual(lanCandidates(interfaces, "utun4"), ["100.113.129.24", "10.0.0.7", "192.168.0.111", "198.18.0.1"]);
  assert.deepEqual(lanCandidates({}, undefined), []);
});
