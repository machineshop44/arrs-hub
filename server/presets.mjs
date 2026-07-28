/** @typedef {'sonarr' | 'radarr'} ArrService */

/**
 * @typedef {object} SyncPreset
 * @property {string} id
 * @property {string} label
 * @property {string} description
 * @property {ArrService} service
 * @property {'series' | 'movie'} qualityDefinition
 * @property {string} trashId
 * @property {string} profileName
 */

/** Recyclarr v8 presets — guide-backed trash_ids (include templates were removed in v8). */
/** @type {SyncPreset[]} */
export const SYNC_PRESETS = [
  {
    id: "sonarr-web-1080p",
    label: "Sonarr · WEB-1080p",
    description: "TRaSH WEB-1080p quality profile + series sizes & custom formats",
    service: "sonarr",
    qualityDefinition: "series",
    trashId: "72dae194fc92bf828f32cde7744e51a1",
    profileName: "WEB-1080p",
  },
  {
    id: "sonarr-web-2160p",
    label: "Sonarr · WEB-2160p",
    description: "TRaSH WEB-2160p quality profile + series sizes & custom formats",
    service: "sonarr",
    qualityDefinition: "series",
    trashId: "d1498e7d189fbe6c7110ceaabb7473e6",
    profileName: "WEB-2160p",
  },
  {
    id: "radarr-hd-bluray-web",
    label: "Radarr · HD Bluray + WEB",
    description: "TRaSH HD Bluray + WEB profile + movie sizes & custom formats",
    service: "radarr",
    qualityDefinition: "movie",
    trashId: "d1d67249d3890e49bc12e275d989a7e9",
    profileName: "HD Bluray + WEB",
  },
  {
    id: "radarr-uhd-bluray-web",
    label: "Radarr · UHD Bluray + WEB",
    description: "TRaSH UHD Bluray + WEB profile + movie sizes & custom formats",
    service: "radarr",
    qualityDefinition: "movie",
    trashId: "64fb5f9858489bdac2af690e27c8f42f",
    profileName: "UHD Bluray + WEB",
  },
];

export function defaultSyncSettings() {
  return {
    sonarr: {
      enabled: true,
      baseUrl: "http://localhost:8989",
      apiKey: "",
    },
    radarr: {
      enabled: true,
      baseUrl: "http://localhost:7878",
      apiKey: "",
    },
    selectedPresets: ["sonarr-web-1080p", "radarr-hd-bluray-web"],
  };
}
