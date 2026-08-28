import os from "node:os";

/** VPN / virtual adapters — Surfshark, WireGuard, Hyper-V, etc. */
const VPN_ADAPTER_RE =
  /surfshark|wireguard|wintun|tap[- ]|tun[- ]|nordlynx|nordvpn|openvpn|vpn|virtual|hyper-v|vmware|vethernet|loopback|npcap|bluetooth|hotspot/i;

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

export function isLikelyVpnAdapter(name) {
  return VPN_ADAPTER_RE.test(String(name || ""));
}

function lanScore(ip, adapterName) {
  if (isLikelyVpnAdapter(adapterName)) return 100;
  if (ip.startsWith("192.168.")) return 0;
  // Real home 10.x (e.g. 10.0.0.x) before generic 10.x VPN tunnels
  if (ip.startsWith("10.0.")) return 1;
  if (ip.startsWith("10.")) return 4;
  if (ip.startsWith("172.16.") || ip.startsWith("172.17.")) return 2;
  if (ip.startsWith("172.")) return 5;
  return 6;
}

/** Physical (non-VPN) interfaces, best LAN first. */
export function listPhysicalLanInterfaces() {
  return [...getLanInterfaces()]
    .filter((iface) => !isLikelyVpnAdapter(iface.name))
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
