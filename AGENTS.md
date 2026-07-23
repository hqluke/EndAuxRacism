# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.
- `controllers/appleMusicController.js` (`getPlaylistTracks`) scrapes Apple Music playlist pages
  with Puppeteer for `<meta>` tags containing song URLs, then resolves metadata via the iTunes
  Lookup API. The `page.goto` call must use `waitUntil: "domcontentloaded"`, not `"networkidle2"`.
  Apple's playlist pages hydrate client-side and strip those meta tags out once their JS finishes
  loading, so waiting for network idle scrapes an already-stripped DOM and silently returns zero
  tracks. Only the initial server-rendered HTML has them.
- `views/room.ejs` (`playSong`, `togglePlayPause`, `sendPlayRequest`): right after the Spotify Web
  Playback SDK's `'ready'` event fires, `activeDeviceId` is set client-side, but Spotify's backend
  can take up to ~1s to finish registering the device — `PUT /me/player/play` briefly 404s
  ("device not found") even with a valid `device_id`. Any client code calling `/spotify/play` must
  check the response and retry (see `sendPlayRequest`'s short backoff) instead of firing-and-forgetting
  the fetch, or a fresh host has to click play multiple times with zero feedback before it works.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
