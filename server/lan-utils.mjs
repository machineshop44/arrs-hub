import os from "node:os";

/** VPN / virtual adapters - Surfshark, WireGuard, VirtualBox, Hyper-V, etc. */
export const VPN_ADAPTER_RE =
  /surfshark|wireguard|wintun|tap[- ]|tun[- ]|nordlynx|nordvpn|openvpn|vpn|virtual|hyper-v|vmware|vethernet|virtualbox|vmnet|loopback|npcap|bluetooth|hotspot/i;

export const VIRTUAL_ADAPTER_RE =
  /virtualbox|vmnet|vethernet|hyper-v|vmware|docker|wsl|npcap/i;

export function isLikelyVpnAdapter(name) {
  return VPN_ADAPTER_RE.test(String(name || ""));
}

export function isLikelyVirtualAdapter(name) {
  const n = String(name || "");
  return isLikelyVpnAdapter(n) || VIRTUAL_ADAPTER_RE.test(n);
}

/** VirtualBox Host-Only, link-local, Hyper-V/WSL defaults, etc. */
export function isLikelyVirtualIp(ip) {
  const parts = String(ip || "")
    .trim()
    .split(".")
    .map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return false;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 192 && parts[1] === 168 && parts[2] === 56) return true;
  // Hyper-V / WSL2 default switch often uses 172.31.x / 172.29.x
  if (parts[0] === 172 && (parts[1] === 31 || parts[1] === 29)) return true;
  return false;
}

/** VirtualBox OUI and common hypervisor MAC prefixes. */
export function isLikelyVirtualMac(mac) {
  const normalized = String(mac || "")
    .trim()
    .replace(/[^a-fA-F0-9]/g, "")
    .toUpperCase();
  if (normalized.length !== 12) return false;
  return (
    normalized.startsWith("0A0027") ||
    normalized.startsWith("00155D") ||
    normalized.startsWith("525400")
  );
}

export function isLikelyVirtualPc(host, mac) {
  return isLikelyVirtualIp(host) || isLikelyVirtualMac(mac);
}

export function lanScore(ip, adapterName) {
  if (isLikelyVirtualAdapter(adapterName)) return 100;
  if (isLikelyVirtualIp(ip)) return 99;
  if (ip.startsWith("192.168.")) return 0;
  if (ip.startsWith("10.0.")) return 1;
  if (ip.startsWith("10.")) return 4;
  if (ip.startsWith("172.16.") || ip.startsWith("172.17.")) return 2;
  if (ip.startsWith("172.")) return 5;
  return 6;
}

/** RFC1918 private IPv4 (preferred for phone QR / LAN URLs). */
export function isPrivateIpv4(ip) {
  const parts = String(ip || "")
    .trim()
    .split(".")
    .map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/**
 * @returns {{ name: string, address: string, mac: string }[]}
 */
export function listLanIpv4Interfaces() {
  const results = [];
  const nets = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(nets)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      const family = addr.family;
      const isV4 = family === "IPv4" || family === 4;
      if (isV4 && !addr.internal) {
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

/** Physical (non-VPN / non-virtual) IPv4 interfaces, best LAN first. */
export function listPhysicalLanIpv4() {
  return [...listLanIpv4Interfaces()]
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

/** Best-effort primary LAN IPv4 for phone QR / Mobile URLs. */
export function pickPrimaryLanIpv4() {
  const physical = listPhysicalLanIpv4().filter(
    (iface) => !isLikelyVirtualIp(iface.address),
  );
  const physicalPrivate = physical.find((i) => isPrivateIpv4(i.address));
  if (physicalPrivate) return physicalPrivate.address;

  const all = [...listLanIpv4Interfaces()]
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
  const anyPrivate = all.find((i) => isPrivateIpv4(i.address));
  if (anyPrivate) return anyPrivate.address;

  // Last resort: physical NIC even if public/CGNAT (user can edit QR URL).
  return physical[0]?.address || all[0]?.address || "";
}
