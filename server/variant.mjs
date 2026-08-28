/** @returns {boolean} Lite downloader build (qBit + SAB port watch only). */
export function isLiteVariant() {
  const v = String(process.env.ARRS_HUB_VARIANT || "").trim().toLowerCase();
  return v === "lite" || v === "arrs-hub-lite";
}

export function hubProductName() {
  return isLiteVariant() ? "Arrs Hub Lite" : "Arrs Hub";
}
