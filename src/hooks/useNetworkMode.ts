import { useEffect, useMemo, useState } from "react";
import { detectNetwork } from "../network";
import type {
  ConnectionMode,
  ConnectionPreference,
  ServiceConfig,
} from "../types";

export function useNetworkMode(
  preference: ConnectionPreference,
  services: ServiceConfig[],
) {
  const [detected, setDetected] = useState<ConnectionMode>("remote");
  const [checking, setChecking] = useState(true);

  const homeUrlsKey = useMemo(
    () =>
      services
        .filter((s) => s.enabled)
        .map((s) => s.homeUrl.trim())
        .filter(Boolean)
        .join("|"),
    [services],
  );

  const homeUrls = useMemo(
    () => (homeUrlsKey ? homeUrlsKey.split("|") : []),
    [homeUrlsKey],
  );

  useEffect(() => {
    if (preference !== "auto") {
      setChecking(false);
      return;
    }

    let cancelled = false;

    const run = () => {
      setChecking(true);
      detectNetwork(homeUrls).then((result) => {
        if (!cancelled) {
          setDetected(result);
          setChecking(false);
        }
      });
    };

    run();

    window.addEventListener("online", run);
    window.addEventListener("focus", run);
    return () => {
      cancelled = true;
      window.removeEventListener("online", run);
      window.removeEventListener("focus", run);
    };
  }, [preference, homeUrls]);

  const activeMode: ConnectionMode =
    preference === "auto" ? detected : preference;

  return { activeMode, detected, checking };
}
