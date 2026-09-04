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
      version: data?.version ? String(data.version) : null,
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
 * Ask Companion for local qBit / SAB / FileFlows Node file versions.
 * @param {string} baseUrl
 * @param {string} apiKey
 */
export async function requestCompanionLocalAppVersions(baseUrl, apiKey) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) {
    return { ok: false, apps: [], message: "No companion URL configured" };
  }
  try {
    const res = await fetch(`${base}/api/local-app-versions`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(apiKey ? { "X-Arrs-Companion-Key": apiKey } : {}),
      },
      signal: AbortSignal.timeout(12000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        apps: [],
        message:
          data?.error ||
          data?.message ||
          `Companion local-app-versions HTTP ${res.status}`,
      };
    }
    return {
      ok: data?.ok !== false,
      apps: Array.isArray(data?.apps) ? data.apps : [],
      checkedAt: data?.checkedAt || null,
      message: data?.message || null,
    };
  } catch (err) {
    return {
      ok: false,
      apps: [],
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
 * Ask Companion whether a local Windows service / process is running.
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {{ windowsService?: string, exePath?: string, exeArgs?: string, exeCwd?: string, processHints?: string[] }} serviceCfg
 */
export async function requestCompanionServiceStatus(baseUrl, apiKey, serviceCfg) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) {
    return {
      ok: false,
      running: false,
      message: "No companion URL configured",
      latencyMs: null,
      method: null,
    };
  }

  const started = Date.now();
  try {
    const res = await fetch(`${base}/api/service-status`, {
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
        processHints: serviceCfg.processHints || [],
      }),
      signal: AbortSignal.timeout(15000),
    });
    const latencyMs = Date.now() - started;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        running: false,
        latencyMs,
        method: null,
        message:
          data?.error ||
          data?.message ||
          `Companion service-status HTTP ${res.status}`,
      };
    }
    return {
      ok: data?.ok !== false,
      running: Boolean(data?.running),
      latencyMs: data?.latencyMs ?? latencyMs,
      method: data?.method || "companion",
      message: data?.message || (data?.running ? "Running" : "Not running"),
      serviceState: data?.serviceState ?? null,
    };
  } catch (err) {
    return {
      ok: false,
      running: false,
      latencyMs: Date.now() - started,
      method: null,
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

/**
 * Ask Companion to silently upgrade an app via winget (qBit / SAB).
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {string} appId
 */
export async function requestCompanionAppUpdate(baseUrl, apiKey, appId) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) {
    return { ok: false, message: "No companion URL configured" };
  }
  try {
    const res = await fetch(`${base}/api/app-update`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Arrs-Companion-Key": apiKey,
      },
      body: JSON.stringify({ id: appId }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        message: data?.error || data?.message || `Companion update HTTP ${res.status}`,
        code: data?.code,
        job: data?.job || null,
      };
    }
    return { ok: true, job: data?.job || null, message: data?.job?.message };
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
 * @param {string} [appId]
 */
export async function requestCompanionAppUpdateStatus(baseUrl, apiKey, appId) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) {
    return { ok: false, job: null, message: "No companion URL configured" };
  }
  const qs = appId ? `?id=${encodeURIComponent(appId)}` : "";
  try {
    const res = await fetch(`${base}/api/app-update${qs}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(apiKey ? { "X-Arrs-Companion-Key": apiKey } : {}),
      },
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        job: null,
        message: data?.error || `Companion update status HTTP ${res.status}`,
      };
    }
    return { ok: true, job: data?.job || null, supported: data?.supported };
  } catch (err) {
    return {
      ok: false,
      job: null,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
