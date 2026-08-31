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

/** VirtualBox Host-Only, link-local, etc. */
export function isLikelyVirtualIp(ip) {
  const parts = String(ip || "")
    .trim()
    .split(".")
    .map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return false;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 192 && parts[1] === 168 && parts[2] === 56) return true;
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
