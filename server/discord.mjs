/**
 * Send a Discord webhook embed. Failures are logged, never thrown to callers.
 * @param {string} webhookUrl
 * @param {{ title: string, description?: string, color?: number }} payload
 */
export async function sendDiscordWebhook(webhookUrl, payload) {
  const url = typeof webhookUrl === "string" ? webhookUrl.trim() : "";
  if (!url || !url.startsWith("https://discord.com/api/webhooks/")) {
    return { ok: false, message: "Invalid Discord webhook URL" };
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "Arrs Hub",
        embeds: [
          {
            title: payload.title,
            description: payload.description || undefined,
            color: payload.color ?? 0x5865f2,
            timestamp: new Date().toISOString(),
            footer: { text: "Arrs Hub · Port Watch" },
          },
        ],
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        message: `Discord webhook HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
      };
    }
    return { ok: true, message: "Sent" };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export const DISCORD_COLORS = {
  down: 0xe74c3c,
  restartOk: 0x2ecc71,
  restartFail: 0xe67e22,
  recovered: 0x3498db,
  test: 0x5865f2,
};
