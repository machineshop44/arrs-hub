import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildOmbiRequestPayload,
  mapMusicArtistHit,
  mapMovieHit,
  mapTvHit,
  mergeMediaSearchHits,
  ombiApprovePath,
  ombiDenyPath,
  ombiHitStatusLabel,
  ombiKindLabel,
  readForeignArtistId,
} from "./ombi-client.mjs";

describe("mergeMediaSearchHits", () => {
  it("puts movies before TV while keeping order within kind", () => {
    const movies = [
      mapMovieHit({ id: 1, title: "Breaking Bad", releaseDate: "2008-01-01" }),
      mapMovieHit({ id: 2, title: "El Camino", releaseDate: "2019-01-01" }),
    ];
    const tv = [
      mapTvHit({
        id: 10,
        title: "Breaking Bad",
        firstAired: "2008-01-20",
        theMovieDbId: 1396,
      }),
    ];
    const merged = mergeMediaSearchHits(movies, tv);
    assert.equal(merged.length, 3);
    assert.equal(merged[0].kind, "movie");
    assert.equal(merged[0].title, "Breaking Bad");
    assert.equal(merged[1].kind, "movie");
    assert.equal(merged[1].title, "El Camino");
    assert.equal(merged[2].kind, "tv");
    assert.equal(merged[2].title, "Breaking Bad");
  });
});

describe("readForeignArtistId", () => {
  it("reads Ombi's misspelled forignArtistId field", () => {
    assert.equal(
      readForeignArtistId({
        artistName: "Taylor Swift",
        forignArtistId: "mbid-taylor",
      }),
      "mbid-taylor",
    );
  });

  it("prefers correctly spelled foreignArtistId when present", () => {
    assert.equal(
      readForeignArtistId({
        foreignArtistId: "correct",
        forignArtistId: "typo",
      }),
      "correct",
    );
  });

  it("maps artist hits that only have forignArtistId", () => {
    const hit = mapMusicArtistHit({
      artistName: "Taylor Swift",
      forignArtistId: "mbid-taylor",
    });
    assert.ok(hit);
    assert.equal(hit.foreignArtistId, "mbid-taylor");
    assert.equal(hit.foreignAlbumId, null);
  });
});

describe("buildOmbiRequestPayload music", () => {
  it("requires foreignAlbumId for music requests", () => {
    assert.throws(
      () =>
        buildOmbiRequestPayload({
          kind: "music",
          title: "Taylor Swift",
          foreignArtistId: "mbid-taylor",
          foreignAlbumId: null,
        }),
      /album/i,
    );
  });

  it("builds music request with foreignAlbumId", () => {
    const payload = buildOmbiRequestPayload({
      kind: "music",
      title: "Folklore",
      foreignAlbumId: "album-mbid",
    });
    assert.equal(payload.path, "/api/v1/Request/music");
    assert.deepEqual(payload.body, { foreignAlbumId: "album-mbid" });
  });

  it("builds movie and TV request bodies", () => {
    assert.deepEqual(
      buildOmbiRequestPayload({
        kind: "movie",
        title: "El Camino",
        tmdbId: 559969,
      }).body,
      { theMovieDbId: 559969 },
    );
    assert.deepEqual(
      buildOmbiRequestPayload({
        kind: "tv",
        title: "Breaking Bad",
        tvdbId: 81189,
      }).body,
      { requestAll: true, tvDbId: 81189 },
    );
  });
});

describe("approve/deny activity paths", () => {
  it("maps approve and deny paths for movie/tv/music", () => {
    assert.equal(ombiApprovePath("movie"), "movie/approve");
    assert.equal(ombiApprovePath("tv"), "tv/approve");
    assert.equal(ombiApprovePath("music"), "music/approve");
    assert.equal(ombiDenyPath("movie"), "movie/deny");
    assert.equal(ombiDenyPath("tv"), "tv/deny");
    assert.equal(ombiDenyPath("music"), "music/deny");
    assert.equal(ombiDenyPath("bogus"), null);
  });
});

describe("ombi labels", () => {
  it("labels status and kind", () => {
    assert.equal(
      ombiHitStatusLabel({ available: true, requested: true }),
      "Available",
    );
    assert.equal(ombiHitStatusLabel({ approved: true }), "Approved");
    assert.equal(ombiHitStatusLabel({ requested: true }), "Requested");
    assert.equal(ombiHitStatusLabel({}), "Not requested");
    assert.equal(ombiKindLabel("movie"), "Movie");
    assert.equal(ombiKindLabel("tv"), "TV");
    assert.equal(ombiKindLabel("music"), "Music");
  });
});
