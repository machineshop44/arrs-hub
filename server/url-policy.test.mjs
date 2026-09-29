import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isPrivateHost,
  requestHostname,
  resolveServiceUrl,
  sanitizeClientServiceUrl,
} from "./url-policy.mjs";

describe("isPrivateHost", () => {
  it("accepts loopback, RFC1918, link-local, ULA, and .local", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "127.5.6.7",
      "::1",
      "[::1]",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.20",
      "169.254.10.10",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "febf::1",
      "plex-pc.local",
    ]) {
      assert.equal(isPrivateHost(host), true, host);
    }
  });

  it("rejects public IPs and names", () => {
    for (const host of [
      "8.8.8.8",
      "172.32.0.1",
      "172.15.0.1",
      "11.0.0.1",
      "192.169.1.1",
      "2001:db8::1",
      "fec0::1",
      "evil.com",
      "10.0.0.1.evil.com",
      "localhost.evil.com",
      "",
    ]) {
      assert.equal(isPrivateHost(host), false, host);
    }
  });
});

describe("requestHostname", () => {
  it("strips port and IPv6 brackets", () => {
    assert.equal(requestHostname({ headers: { host: "203.0.113.9:3000" } }), "203.0.113.9");
    assert.equal(requestHostname({ headers: { host: "[2001:db8::1]:3000" } }), "2001:db8::1");
    assert.equal(requestHostname({ headers: { host: "Hub.Example.com" } }), "hub.example.com");
    assert.equal(requestHostname({ headers: {} }), "");
  });
});

describe("sanitizeClientServiceUrl", () => {
  it("keeps LAN and loopback URLs", () => {
    assert.equal(
      sanitizeClientServiceUrl("http://192.168.1.20:8989/"),
      "http://192.168.1.20:8989",
    );
    assert.equal(
      sanitizeClientServiceUrl("https://localhost:7878/radarr"),
      "https://localhost:7878/radarr",
    );
  });

  it("rejects non-http schemes and garbage", () => {
    assert.equal(sanitizeClientServiceUrl("file:///C:/secret"), "");
    assert.equal(sanitizeClientServiceUrl("ftp://192.168.1.2/"), "");
    assert.equal(sanitizeClientServiceUrl("javascript:alert(1)"), "");
    assert.equal(sanitizeClientServiceUrl("not a url"), "");
    assert.equal(sanitizeClientServiceUrl(""), "");
  });

  it("rejects unknown public hosts", () => {
    assert.equal(sanitizeClientServiceUrl("http://evil.example:8989"), "");
    assert.equal(sanitizeClientServiceUrl("http://8.8.8.8:8989"), "");
  });

  it("accepts hosts already known from Hub config", () => {
    assert.equal(
      sanitizeClientServiceUrl("http://nas.example.net:8686", {
        knownHosts: ["nas.example.net"],
      }),
      "http://nas.example.net:8686",
    );
  });

  it("rewrites the Hub's own public host to 127.0.0.1 keeping port/path", () => {
    assert.equal(
      sanitizeClientServiceUrl("http://203.0.113.9:8989/sonarr/", {
        selfHosts: ["203.0.113.9"],
      }),
      "http://127.0.0.1:8989/sonarr",
    );
    assert.equal(
      sanitizeClientServiceUrl("https://Hub.Example.com:9443", {
        selfHosts: ["hub.example.com"],
      }),
      "https://127.0.0.1:9443",
    );
  });

  it("does not rewrite when the self host is private", () => {
    assert.equal(
      sanitizeClientServiceUrl("http://192.168.1.20:8989", {
        selfHosts: ["192.168.1.20"],
      }),
      "http://192.168.1.20:8989",
    );
  });
});

describe("resolveServiceUrl", () => {
  it("prefers the Hub-configured URL over the client URL", () => {
    assert.equal(
      resolveServiceUrl({
        hubUrl: "http://localhost:8989/",
        clientUrl: "http://192.168.1.50:8989",
      }),
      "http://localhost:8989",
    );
  });

  it("never falls back to a rejected client URL", () => {
    assert.equal(
      resolveServiceUrl({ clientUrl: "http://evil.example:8686" }),
      "",
    );
  });

  it("uses an allowed client URL when the Hub has none", () => {
    assert.equal(
      resolveServiceUrl({ clientUrl: "http://192.168.1.50:8686" }),
      "http://192.168.1.50:8686",
    );
  });

  it("lets an allowed client URL override an untouched factory default", () => {
    assert.equal(
      resolveServiceUrl({
        hubUrl: "http://localhost:8080",
        hubDefaultUrl: "http://localhost:8080",
        clientUrl: "http://192.168.1.60:8080",
      }),
      "http://192.168.1.60:8080",
    );
    assert.equal(
      resolveServiceUrl({
        hubUrl: "http://localhost:8080",
        hubDefaultUrl: "http://localhost:8080",
        clientUrl: "http://evil.example:8080",
      }),
      "http://localhost:8080",
    );
  });

  it("maps a WAN client URL for this Hub to loopback when the Hub has none", () => {
    assert.equal(
      resolveServiceUrl({
        clientUrl: "http://203.0.113.9:8787",
        selfHosts: ["203.0.113.9"],
      }),
      "http://127.0.0.1:8787",
    );
  });

  it("ignores a non-http Hub URL", () => {
    assert.equal(
      resolveServiceUrl({
        hubUrl: "companion://local",
        clientUrl: "http://10.0.0.4:9000",
      }),
      "http://10.0.0.4:9000",
    );
  });
});
