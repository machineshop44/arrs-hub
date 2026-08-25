/// <reference types="vite/client" />

export {};

declare global {
  interface Window {
    arrsHubDesktop?: {
      playInVlc: (
        urls: string[],
      ) => Promise<{ ok: boolean; vlcPath?: string; error?: string }>;
      isDesktop: () => boolean;
    };
  }
}
