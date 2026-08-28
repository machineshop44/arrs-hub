/**
 * Hub → Companion HTTP client (LAN only).
 */

function normalizeBaseUrl(raw) {
  const trimmed = String(raw || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.includes("://") ? trimmed : `http://${trimmed}`;
}

/**
 * @param {string} baseUrl
 * @param {string} apiKey
 */
export async function checkCompanionHealth(baseUrl, apiKey) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) {
    return {
      ok: false,
      online: false,
      message: "No companion URL configured",
    };
  }

  const url = `${base}/api/health`;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: apiKey ? { "X-Arrs-Companion-Key": apiKey } : {},
      signal: AbortSignal.timeout(4000),
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return {
        ok: false,
        online: false,
        latencyMs,
        message: `Companion health HTTP ${res.status}`,
      };
    }
    const data = await res.json();
    return {
      ok: true,
      online: Boolean(data?.ok),
      latencyMs,
      message: data?.ok ? "Companion online" : "Companion unhealthy",
      product: data?.product,
    };
  } catch (err) {
    return {
      ok: false,
      online: false,
      latencyMs: Date.now() - started,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {{ windowsService?: string, exePath?: string, exeArgs?: string, exeCwd?: string }} serviceCfg
 */
export async function requestCompanionRestart(baseUrl, apiKey, serviceCfg) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) {
    return { ok: false, message: "No companion URL configured" };
  }

  try {
    const res = await fetch(`${base}/api/restart`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Arrs-Companion-Key": apiKey,
      },
      body: JSON.stringify({
        windowsService: serviceCfg.windowsService || "",
        exePath: serviceCfg.exePath || "",
        exeArgs: serviceCfg.exeArgs || "",
        exeCwd: serviceCfg.exeCwd || "",
      }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        message: data?.error || data?.message || `Companion restart HTTP ${res.status}`,
      };
    }
    return {
      ok: Boolean(data?.ok),
      message: data?.message || "Companion restart finished",
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {string} mac
 * @param {string} host
 */
export async function requestCompanionWol(baseUrl, apiKey, mac, host = "") {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) {
    return { ok: false, message: "No companion URL configured" };
  }

  try {
    const res = await fetch(`${base}/api/wol`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Arrs-Companion-Key": apiKey,
      },
      body: JSON.stringify({ mac, host }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        message: data?.error || data?.message || `Companion WOL HTTP ${res.status}`,
      };
    }
    return {
      ok: Boolean(data?.ok),
      message: data?.message || "Companion WOL sent",
      mac: data?.mac,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
