const { contextBridge, ipcRenderer } = require("electron");

/**
 * Desktop bridge for Arrs Hub renderer (contextIsolation).
 * Local workouts open in VLC with hub mode=direct URLs — same idea as mobile.
 */
contextBridge.exposeInMainWorld("arrsHubDesktop", {
  /**
   * @param {string[]} urls Absolute http(s) media URLs for VLC playlist.
   * @returns {Promise<{ ok: boolean, vlcPath?: string, error?: string }>}
   */
  playInVlc(urls) {
    return ipcRenderer.invoke("workouts:play-vlc", { urls });
  },
  isDesktop() {
    return true;
  },
});
