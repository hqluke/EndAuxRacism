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
- `views/room.ejs` library sidebar: `#library-sidebar`'s CSS default (`styles/rooms.css`) is
  visually *open* at desktop widths (only `.collapsed` hides it) but *hidden* at mobile widths
  (only `.open` shows it) - the two breakpoints have opposite defaults. Any init logic touching
  `sidebar.classList` must set explicit `open`/`collapsed` state for both branches, not just
  mobile, or the DOM class and the visual state (and anything gated on `classList.contains('open')`,
  like loading playlists) drift apart on desktop.
- Spotify's `GET /playlists/{id}/items` returns 403 for playlists the user follows but doesn't own
  or collaborate on - this is documented Spotify API behavior (`playlist-read-private` only covers
  the *authenticated user's own* playlists), not a missing-scope bug and not something a scope
  change fixes. `controllers/spotifyController.js` `getPlaylistTracks` passes that status straight
  through; the frontend in `views/room.ejs` `switchSource()` shows an inline "can't be loaded"
  message for it rather than erroring.
- No live Spotify dev credentials in this sandbox (`.env` has dummy client id/secret) - dev/test
  end-to-end reproduction against real Spotify OAuth or API responses isn't possible here. To
  reproduce a bug in the room UI, stand up a standalone harness outside the repo that requires the
  real `routes/`/`controllers/`/`views/` unmodified, swaps in a `req.login()` debug route for the
  OAuth handshake, and overrides `global.fetch` to fake `api.spotify.com` responses (including a
  running `socket.io` server - `views/room.ejs` calls `io()` synchronously near the top of its
  inline script, so a failed socket.io client load throws and no later script in that block runs,
  including sidebar init).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
