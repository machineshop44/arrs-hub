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
      found.set(id, {
        name: device.friendlyName || device.name || host,
        host,
        address: host,
        port: Number(device.port) || 8009,
        machineIdentifier: id,
        product: "Chromecast / Cast",
        deviceClass: "cast",
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
 * Play a list of media URLs on a Chromecast (warmup then day).
 * @param {string} host
 * @param {{ title: string, url: string }[]} playlist
 */
export function castPlaylistToDevice(host, playlist) {
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
      playSequential(device, playlist, 0)
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

function playSequential(device, playlist, index) {
  return new Promise((resolve, reject) => {
    const item = playlist[index];
    if (!item) {
      resolve({ ok: true, played: playlist.length });
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

        const onFinished = () => {
          device.removeListener?.("finished", onFinished);
          device.removeListener?.("status", onStatus);
          playSequential(device, playlist, index + 1).then(resolve).catch(reject);
        };

        const onStatus = (status) => {
          // Some devices only emit status updates; finished is preferred.
          if (status?.playerState === "IDLE" && status?.idleReason === "FINISHED") {
            onFinished();
          }
        };

        device.on?.("finished", onFinished);
        device.on?.("status", onStatus);

        // Safety: if events never fire, don't hang forever on first item start ack
        if (index === playlist.length - 1) {
          // Last item started — resolve after a short settle so UI can show success.
          // Caller can leave the cast playing.
          setTimeout(() => resolve({ ok: true, playing: item.title }), 500);
        }
      },
    );
  });
}
