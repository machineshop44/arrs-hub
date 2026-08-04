import ChromecastAPI from "chromecast-api";

/**
 * Discover Chromecast / Cast-enabled devices on the LAN.
 * @param {number} [timeoutMs]
 * @returns {Promise<{ name: string, host: string, address: string, port: number, machineIdentifier: string, product: string, deviceClass: string, castType: string, protocolCapabilities: string[] }[]>}
 */
export function discoverCastDevices(timeoutMs = 3500) {
  return new Promise((resolve) => {
    /** @type {Map<string, any>} */
    const found = new Map();
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        client.destroy?.();
      } catch {
        // ignore
      }
      resolve([...found.values()]);
    };

    let client;
    try {
      client = new ChromecastAPI();
    } catch (err) {
      console.error("Chromecast discovery failed to start:", err?.message || err);
      resolve([]);
      return;
    }

    client.on("device", (device) => {
      const host = device.host || device.name;
      if (!host) return;
      const id = `cast-${host}`;
      const name = device.friendlyName || device.name || host;
      const nameLower = String(name).toLowerCase();
      const deviceClass = /\b(speaker|soundbar|nest mini|nest audio|home mini|google home)\b/.test(
        nameLower,
      )
        ? "speaker"
        : /\b(tv|chromecast|shield|roku)\b/.test(nameLower)
          ? "tv"
          : "cast";
      found.set(id, {
        name,
        host,
        address: host,
        port: Number(device.port) || 8009,
        machineIdentifier: id,
        product: "Chromecast / Cast",
        deviceClass,
        platform: "Cast",
        provides: "player",
        castType: "chromecast",
        protocolCapabilities: ["playback", "cast"],
      });
    });

    client.on("error", (err) => {
      console.error("Chromecast discovery error:", err?.message || err);
    });

    setTimeout(finish, timeoutMs);
  });
}

/**
 * Play media on a Chromecast.
 * @param {string} host
 * @param {{ title: string, url: string }[]} playlist
 * @param {{ waitForFinish?: boolean }} [options]
 *   When waitForFinish is true (default for a single item that should block),
 *   resolve after that item finishes. When false, resolve shortly after start.
 */
export function castPlaylistToDevice(host, playlist, options = {}) {
  const waitForFinish = options.waitForFinish !== false && playlist.length === 1;
  return new Promise((resolve, reject) => {
    let client;
    try {
      client = new ChromecastAPI();
    } catch (err) {
      reject(err);
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out finding Cast device ${host}`));
    }, 8000);

    const cleanup = () => {
      clearTimeout(timer);
      try {
        client.destroy?.();
      } catch {
        // ignore
      }
    };

    client.on("device", (device) => {
      const deviceHost = device.host || device.name;
      if (deviceHost !== host && device.name !== host) return;

      clearTimeout(timer);
      playOne(device, playlist[0], { waitForFinish })
        .then((result) => {
          cleanup();
          resolve(result);
        })
        .catch((err) => {
          cleanup();
          reject(err);
        });
    });

    client.on("error", (err) => {
      cleanup();
      reject(err);
    });
  });
}

/**
 * @param {any} device
 * @param {{ title: string, url: string }} item
 * @param {{ waitForFinish?: boolean }} options
 */
function playOne(device, item, options = {}) {
  return new Promise((resolve, reject) => {
    if (!item) {
      resolve({ ok: true, played: 0 });
      return;
    }

    device.play(
      item.url,
      { title: item.title, type: "video/mp4" },
      (err) => {
        if (err) {
          reject(
            new Error(
              `Cast failed on "${item.title}": ${err.message || String(err)}`,
            ),
          );
          return;
        }

        if (!options.waitForFinish) {
          setTimeout(() => resolve({ ok: true, playing: item.title }), 500);
          return;
        }

        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          device.removeListener?.("finished", onFinished);
          device.removeListener?.("status", onStatus);
          resolve({ ok: true, finished: item.title });
        };

        const onFinished = () => finish();

        const onStatus = (status) => {
          if (status?.playerState === "IDLE" && status?.idleReason === "FINISHED") {
            finish();
          }
        };

        device.on?.("finished", onFinished);
        device.on?.("status", onStatus);
      },
    );
  });
}
