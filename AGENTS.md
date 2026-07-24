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
  including sidebar init). For a bug that's pure CSS/markup (no auth, no live data needed), skip
  that harness entirely - serve the real `styles/*.css` plus a static-ified copy of the view's body
  markup from a throwaway static file server instead; it's faithful enough for layout bugs and much
  cheaper.
- `#player-bar`/`#guest-bar` in `styles/rooms.css` and `styles/dashboard.css` rely on
  `padding-bottom: env(safe-area-inset-bottom, 0px)` for PWA standalone-mode safe-area clearance.
  Any later same-specificity rule for that selector that sets the `padding` *shorthand* (not just
  `padding-bottom`) silently zeroes this out. This hit both files independently: `dashboard.css`'s
  base `#player-bar` rule, and every one of `rooms.css`'s mobile `@media` breakpoints (768/415/360/300px)
  for `#player-bar, #guest-bar`. Both are now fixed the same way: add `padding-bottom:
  env(safe-area-inset-bottom, 0px)` as the last declaration in the same rule, after the shorthand.
  To verify this class of bug without a real notched device or a way to fake `env()`'s value
  (Chrome has no devtools override for safe-area-inset-*), swap the real env name for a guaranteed-
  unsupported one with a non-zero fallback (e.g. `env(safe-area-inset-bottom, 0px)` ->
  `env(some-nonexistent-name, 40px)`) in a scratch copy of the CSS, serve it, and read
  `getComputedStyle(...).paddingBottom` at each breakpoint - the fallback survives if the fix is
  correct, and collapses to `0px` if a later shorthand is still clobbering it.
- `views/room.ejs`'s host `#player-bar` (`.now-playing`, `.player-controls`, `.player-bar-right`)
  overflows horizontally below ~360px viewport width, pushing `.player-bar-right` (the Queue button)
  off the right edge. Root cause: `.now-playing` gets `width: 180px; flex-shrink: 0;` once at the
  768px breakpoint and it is *never* reduced at the narrower 415/360/300px breakpoints, unlike every
  other element in the bar (art size, control gaps, font sizes) which keeps shrinking at each one -
  so the bar's minimum content width plateaus around ~360px while the viewport keeps shrinking past
  it. Fixed by adding a `.now-playing { width: ... }` override at each of those three breakpoints so
  it keeps shrinking in step with the rest of the bar. Also fixed a companion bug found in the same
  investigation: the 300px breakpoint's `#np-art`/`#guest-np-art` was `60px` - larger than the 360px
  breakpoint's `32px`, breaking the monotonic 40->36->32 shrink pattern (almost certainly a
  copy-paste slip) - restored to `28px` to continue the trend. The guest bar (`#guest-np`) was never
  affected - it uses `flex: 1; min-width: 0; overflow: hidden` instead of a fixed width, so it
  already shrinks correctly.
- To find the true content width of a flex bar and confirm/deny an overflow hypothesis, don't trust
  a hunch about which child is misbehaving - measure directly: `element.scrollWidth - window.innerWidth`
  for overflow amount, and `getBoundingClientRect()` on each flex child across every breakpoint width,
  not just one. In this investigation the actual overflowing element (`.now-playing`'s stale fixed
  width) turned out to be different from the one initially suspected (`.progress-wrap` inside
  `.player-controls`) - that suspected element doesn't even exist in the player bar's real markup,
  it only appears inside the separate now-playing fullscreen modal (`.np-modal-progress`).
- `public/logo.svg` is the master brand icon: a nested-`<svg>` wrapper pads the source art (non-square,
  600x449) onto a 600x600 black (`#000000`, matching `manifest.json`'s `background_color`/`theme_color`)
  square canvas, centered, so favicon/PWA/apple-touch-icon consumers that assume square art still get
  the full artwork. All raster favicons (`favicon-32x32.png`, `apple-touch-icon.png`, `icon-192.png`,
  `icon-512.png`) are generated from this file via `rsvg-convert -w <n> -h <n>` (available on this
  box; no imagemagick/inkscape SVG rasterization needed). The landing page header in `views/index.ejs`
  intentionally uses the same padded square asset uncropped rather than the raw 4:3 art - since the
  page background (`#0a0a0a`) is visually indistinguishable from the pad color, the black margin
  disappears and only the artwork reads, with no extra CSS cropping required. This source art has fine
  line detail that does not survive shrinking to real favicon sizes: it stays legible at 512px and is
  still readable at 192px, but at 32px it degrades to a rough blob and at 16px is illegible - a known,
  accepted tradeoff for this asset, not a rendering bug.
- `views/index.ejs`'s `<h1>` ("EndAuxRacism") is sized with `font-size: clamp(1.15rem, 5.5vw, 3.2rem)`
  plus a smaller fixed size in the `@media (max-width: 300px)` breakpoint. Both numbers were picked
  by measuring the rendered word width against the actual available space (viewport minus `body`'s
  `padding: 24px 20px` minus the h1's own left/right padding) at each target width, not by eyeballing
  it - "EndAuxRacism" is a single word with `white-space: nowrap` (intentionally, since it must never
  split across lines), so if a future size bump makes it wider than the available space at some
  supported width, it will silently clip at the viewport edge instead of wrapping. Re-verify with the
  same measure-then-size approach (render a hidden span with the h1's font styles and binary-search
  font sizes against `getBoundingClientRect().width`) before changing these numbers, across the full
  range from desktop down to the 300px breakpoint.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
