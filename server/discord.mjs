/**
 * Send a Discord webhook embed. Failures are logged, never thrown to callers.
 * @param {string} webhookUrl
 * @param {{ title: string, description?: string, color?: number }} payload
 */

const DISCORD_WEBHOOK_HOSTS = new Set([
  "discord.com",
  "discordapp.com",
  "canary.discord.com",
  "ptb.discord.com",
]);

function isAllowedDiscordWebhookUrl(raw) {
  const url = typeof raw === "string" ? raw.trim() : "";
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    if (!DISCORD_WEBHOOK_HOSTS.has(host)) return false;
    return /^\/api\/webhooks\/\d+\/[\w-]+/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

export async function sendDiscordWebhook(webhookUrl, payload) {
  const url = typeof webhookUrl === "string" ? webhookUrl.trim() : "";
  if (!isAllowedDiscordWebhookUrl(url)) {
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
