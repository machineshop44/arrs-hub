import os from "node:os";
import {
  isLikelyVirtualAdapter,
  isLikelyVirtualIp,
  isLikelyVirtualMac,
  lanScore,
} from "../server/lan-utils.mjs";

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

/** Physical (non-VPN, non-virtual) interfaces, best LAN first. */
export function listPhysicalLanInterfaces() {
  return [...getLanInterfaces()]
    .filter(
      (iface) =>
        !isLikelyVirtualAdapter(iface.name) &&
        !isLikelyVirtualIp(iface.address) &&
        !isLikelyVirtualMac(iface.mac),
    )
    .sort(
      (a, b) =>
        lanScore(a.address, a.name) - lanScore(b.address, b.name) ||
        a.address.localeCompare(b.address),
    );
}

/** Prefer typical home LAN prefixes over VPN/virtual adapters. */
export function pickPrimaryLan() {
  return listPhysicalLanInterfaces()[0] || null;
}

/** Unique /24 subnets from physical interfaces (for multi-NIC / VPN bypass). */
export function listPhysicalSubnets() {
  const seen = new Set();
  const subnets = [];
  for (const iface of listPhysicalLanInterfaces()) {
    const parts = iface.address.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) continue;
    const key = `${parts[0]}.${parts[1]}.${parts[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    subnets.push({
      prefix: key,
      iface,
    });
  }
  return subnets;
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
