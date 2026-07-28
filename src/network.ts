/** Parse IPv4 from a hostname string. Returns null if not an IPv4 address. */
export function parseIpv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host.trim());
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return parts;
}

export function isPrivateIpv4(parts: number[]): boolean {
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/** /24 for typical home LAN ranges. */
export function sameLocalNetwork(a: number[], b: number[]): boolean {
  if (a[0] === 192 && a[1] === 168 && b[0] === 192 && b[1] === 168) {
    return a[2] === b[2];
  }
  if (a[0] === 10 && b[0] === 10) {
    return a[1] === b[1];
  }
  if (
    a[0] === 172 &&
    b[0] === 172 &&
    a[1] >= 16 &&
    a[1] <= 31 &&
    b[1] >= 16 &&
    b[1] <= 31
  ) {
    return a[1] === b[1];
  }
  if (a[0] === 127 && b[0] === 127) return true;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

export function hostFromUrl(raw: string): string | null {
  try {
    const withProtocol = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)
      ? raw
      : `http://${raw}`;
    return new URL(withProtocol).hostname;
  } catch {
    return null;
  }
}

export function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const withProtocol = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
      ? trimmed
      : `http://${trimmed}`;
    return new URL(withProtocol).origin;
  } catch {
    return null;
  }
}

export function collectHomeHosts(homeUrls: string[]): number[][] {
  const ips: number[][] = [];
  for (const raw of homeUrls) {
    const host = hostFromUrl(raw.trim());
    if (!host) continue;
    const ip = parseIpv4(host);
    if (ip && isPrivateIpv4(ip)) ips.push(ip);
  }
  return ips;
}

/**
 * Best-effort local IPv4 discovery via WebRTC.
 */
export function discoverLocalIpv4s(timeoutMs = 1500): Promise<number[][]> {
  return new Promise((resolve) => {
    const found = new Map<string, number[]>();
    const done = () => resolve([...found.values()]);

    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection({ iceServers: [] });
    } catch {
      done();
      return;
    }

    const timer = window.setTimeout(() => {
      pc.close();
      done();
    }, timeoutMs);

    pc.createDataChannel("");
    pc.onicecandidate = (event) => {
      const candidate = event.candidate?.candidate;
      if (!candidate) {
        if (event.candidate === null) {
          window.clearTimeout(timer);
          pc.close();
          done();
        }
        return;
      }

      const match = /([0-9]{1,3}(?:\.[0-9]{1,3}){3})/.exec(candidate);
      if (!match) return;
      const ip = parseIpv4(match[1]);
      if (!ip || !isPrivateIpv4(ip)) return;
      found.set(match[1], ip);
    };

    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .catch(() => {
        window.clearTimeout(timer);
        pc.close();
        done();
      });
  });
}

/**
 * Probe whether a home origin answers on the network.
 * Uses no-cors so missing CORS headers still count as "reachable".
 */
export async function isOriginReachable(
  origin: string,
  timeoutMs = 2000,
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    await fetch(origin, {
      mode: "no-cors",
      cache: "no-store",
      signal: controller.signal,
    });
    window.clearTimeout(timer);
    return true;
  } catch {
    return false;
  }
}

export type DetectedNetwork = "home" | "remote";

/**
 * Decide home vs remote without assuming localhost page = home network.
 * 1) Same LAN as configured home IPs (WebRTC)
 * 2) Else: can we reach any home origin?
 * 3) Else: remote
 */
export async function detectNetwork(
  homeUrls: string[],
): Promise<DetectedNetwork> {
  const homeIps = collectHomeHosts(homeUrls);
  const localIps = await discoverLocalIpv4s();

  for (const local of localIps) {
    for (const home of homeIps) {
      if (sameLocalNetwork(local, home)) {
        return "home";
      }
    }
  }

  const origins = [
    ...new Set(
      homeUrls
        .map((url) => normalizeUrl(url))
        .filter((origin): origin is string => Boolean(origin)),
    ),
  ].slice(0, 3);

  if (origins.length > 0) {
    const results = await Promise.all(
      origins.map((origin) => isOriginReachable(origin)),
    );
    if (results.some(Boolean)) return "home";
  }

  return "remote";
}
