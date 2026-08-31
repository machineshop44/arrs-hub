import dgram from "node:dgram";
import { spawn } from "node:child_process";
import net from "node:net";

/**
 * Normalize MAC to AA:BB:CC:DD:EE:FF
 * @param {string} mac
 */
export function normalizeMac(mac) {
  const hex = String(mac || "")
    .trim()
    .replace(/[^a-fA-F0-9]/g, "")
    .toUpperCase();
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g).join(":");
}

/**
 * Send a Wake-on-LAN magic packet (LAN/broadcast only - not over the internet).
 * @param {string} mac
 * @param {{ broadcastAddress?: string, port?: number }} [options]
 */
export function sendWakeOnLan(mac, options = {}) {
  return new Promise((resolve, reject) => {
    const normalized = normalizeMac(mac);
    if (!normalized) {
      reject(new Error("MAC address must look like AA:BB:CC:DD:EE:FF"));
      return;
    }

    const macBytes = normalized.split(":").map((h) => Number.parseInt(h, 16));
    const packet = Buffer.alloc(102);
    packet.fill(0xff, 0, 6);
    for (let i = 0; i < 16; i += 1) {
      Buffer.from(macBytes).copy(packet, 6 + i * 6);
    }

    const port = Number(options.port) || 9;
    const targets = [
      options.broadcastAddress || "255.255.255.255",
      "255.255.255.255",
    ].filter((v, i, arr) => arr.indexOf(v) === i);

    const socket = dgram.createSocket("udp4");
    socket.on("error", (err) => {
      try {
        socket.close();
      } catch {
        // ignore
      }
      reject(err);
    });

    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch {
        // ignore
      }

      let pending = targets.length;
      let lastError = null;
      for (const address of targets) {
        socket.send(packet, 0, packet.length, port, address, (err) => {
          if (err) lastError = err;
          pending -= 1;
          if (pending === 0) {
            socket.close();
            if (lastError) reject(lastError);
            else resolve({ ok: true, mac: normalized, addresses: targets });
          }
        });
      }
    });
  });
}

/**
 * Best-effort "is this PC on?" check: ICMP ping, then a few common TCP ports.
 * @param {string} host
 * @param {{ timeoutMs?: number, tcpPorts?: number[] }} [options]
 */
export async function isHostOnline(host, options = {}) {
  const target = String(host || "").trim();
  if (!target) {
    return { online: false, method: null, message: "No host/IP configured" };
  }

  const timeoutMs = options.timeoutMs ?? 2000;
  const tcpPorts = options.tcpPorts ?? [445, 3389, 22, 80, 443, 32400];

  const ping = await pingHost(target, timeoutMs);
  if (ping.online) return ping;

  for (const port of tcpPorts) {
    const tcp = await tcpProbe(target, port, timeoutMs);
    if (tcp.online) return tcp;
  }

  return {
    online: false,
    method: null,
    message: ping.message || "Host did not respond",
  };
}

function pingHost(host, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(
      "ping",
      ["-n", "1", "-w", String(Math.max(200, timeoutMs)), host],
      { windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
    }, timeoutMs + 500);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = `${stdout}\n${stderr}`;
      const online =
        code === 0 &&
        /ttl=/i.test(text) &&
        !/destination host unreachable|request timed out|100% loss/i.test(text);
      resolve({
        online,
        method: online ? "ping" : null,
        message: online ? "Ping replied" : "Ping failed",
      });
    });
  });
}

function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (online, message) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        online,
        method: online ? `tcp:${port}` : null,
        message,
      });
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => finish(true, `TCP ${port} open`));
    socket.on("timeout", () => finish(false, `TCP ${port} timed out`));
    socket.on("error", () => finish(false, `TCP ${port} failed`));
  });
}

/**
 * Guess a directed broadcast like 192.168.1.255 from an IPv4 host.
 * @param {string} host
 */
export function guessBroadcastAddress(host) {
  const m = String(host || "").match(
    /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/,
  );
  if (!m) return null;
  return `${m[1]}.${m[2]}.${m[3]}.255`;
}
