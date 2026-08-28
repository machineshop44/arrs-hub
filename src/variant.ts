/** Set at build time via Vite `define` (lite mode) or dev env. */
declare const __ARRS_HUB_VARIANT__: string | undefined;

function readVariant(): string {
  if (typeof __ARRS_HUB_VARIANT__ === "string" && __ARRS_HUB_VARIANT__) {
    return __ARRS_HUB_VARIANT__;
  }
  return "";
}

export const HUB_VARIANT = readVariant();

export const IS_LITE_VARIANT =
  HUB_VARIANT === "lite" || HUB_VARIANT === "arrs-hub-lite";
