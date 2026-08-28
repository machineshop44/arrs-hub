import os from "node:os";

/**
 * @returns {{ name: string, address: string, mac: string }[]}
 */
export function getLanInterfaces() {
  const results = [];
  const nets = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(nets)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        results.push({
          name,
          address: addr.address,
          mac: addr.mac || "",
        });
      }
    }
  }
  return results;
}

/** Prefer typical home LAN prefixes over VPN/virtual adapters. */
export function pickPrimaryLan() {
  const ifaces = getLanInterfaces();
  const score = (ip) => {
    if (ip.startsWith("192.168.")) return 0;
    if (ip.startsWith("10.")) return 1;
    if (ip.startsWith("172.")) return 2;
    return 3;
  };
  return [...ifaces].sort((a, b) => score(a.address) - score(b.address))[0] || null;
}

/** @param {string} ip */
export function subnetHosts(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return [];
  const base = `${parts[0]}.${parts[1]}.${parts[2]}`;
  const hosts = [];
  for (let i = 1; i <= 254; i += 1) {
    hosts.push(`${base}.${i}`);
  }
  return hosts;
}
