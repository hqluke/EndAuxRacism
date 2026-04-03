// ── Per-user in-memory cache ──────────────────────────────────────────────────
// Keyed by userId → { [key]: { value, ts } }
// Each key has its own TTL so fetching playlists doesn't expire liked songs.
const userCache = new Map();
const DEFAULT_TTL_MS = 5 * 60 * 1000;

// ── Request coalescing ─────────────────────────────────────────────────────────
// Prevents thundering herd: if multiple requests for the same key arrive while
// a fetch is in-flight, they all share the same promise instead of firing again.
const pendingFetches = new Map();

async function getWithCoalescing(userId, cacheKey, fetchFn) {
    const pendingKey = `${userId}:${cacheKey}`;
    if (pendingFetches.has(pendingKey)) {
        console.log(`[cache] coalescing request for ${cacheKey}`);
        return pendingFetches.get(pendingKey);
    }
    const promise = fetchFn().finally(() => pendingFetches.delete(pendingKey));
    pendingFetches.set(pendingKey, promise);
    return promise;
}

// TTL lookup — supports exact keys and key prefixes (e.g. 'likedSongs_' matches
// 'likedSongs_0_50', 'likedSongs_50_50', etc.)
function getTtl(key) {
    if (key.startsWith('likedSongs'))  return 5  * 60 * 1000;
    if (key === 'playlists')           return 15 * 60 * 1000;
    if (key.startsWith('playlist_'))   return 10 * 60 * 1000;
    return DEFAULT_TTL_MS;
}

function getCached(userId, key) {
    const entry = userCache.get(userId);
    if (!entry || !entry[key]) return null;
    if (Date.now() - entry[key].ts > getTtl(key)) { delete entry[key]; return null; }
    return entry[key].value;
}

function setCache(userId, key, value) {
    const entry = userCache.get(userId) || {};
    entry[key] = { value, ts: Date.now() };
    userCache.set(userId, entry);
}

// Sleep helper for Retry-After
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Parse Spotify's Retry-After header — may be a relative number of seconds
// ("2") or a full HTTP-date string ("Fri, 21 Mar 2026 05:12:32 GMT").
// Returns milliseconds to wait, capped at 30 seconds.
function parseRetryAfter(header) {
    if (!header) return 2000;
    const asSeconds = Number(header.trim());
    if (!isNaN(asSeconds)) return Math.min(asSeconds * 1000, 30_000);
    const future = Date.parse(header);
    if (!isNaN(future)) return Math.min(Math.max(future - Date.now(), 0), 30_000);
    return 2000;
}

// Spotify fetch with automatic 429 back-off (exponential, max 10 retries)
async function spotifyFetch(url, options, retries = 10, baseDelayMs = 1000) {
    const res = await fetch(url, options);
    if (res.status === 429 && retries > 0) {
        const serverDelay = parseRetryAfter(res.headers.get('Retry-After'));
        const backoffDelay = Math.min(serverDelay || baseDelayMs, 30_000);
        const wait = Math.max(backoffDelay, baseDelayMs);
        console.warn(`[spotify] 429 rate-limit — waiting ${wait}ms before retry (${retries} left)`);
        await sleep(wait);
        return spotifyFetch(url, options, retries - 1, baseDelayMs * 2);
    }
    return res;
}

// Helper: convert ms to '3:45' format
const getDashboard = async (req, res, next) => {
    try {
        const userId      = req.user.id;
        const accessToken = req.user.accessToken;

        // Serve from cache if fresh — avoids a Spotify call on every page reload
        const cached = getCached(userId, 'likedSongs_0_50');
        if (cached) {
            console.log('[dashboard] serving liked songs from cache —', cached.length, 'songs');
            return res.render("dashboard", { user: req.user, songs: cached });
        }

        const response = await spotifyFetch(
            "https://api.spotify.com/v1/me/tracks?limit=50",
            { headers: { Authorization: `Bearer ${accessToken}` } },
        );

        if (!response.ok) throw new Error(`Spotify API error: ${response.status}`);

        const data = await response.json();
        const songs = data.items.map((item) => ({
            id:       item.track.id,
            uri:      item.track.uri,
            name:     item.track.name,
            artist:   item.track.artists.map((a) => a.name).join(", "),
            album:    item.track.album.name,
            image:    item.track.album.images[1]?.url || item.track.album.images[0]?.url,
            duration: msToMinSec(item.track.duration_ms),
            addedAt:  new Date(item.added_at).toLocaleDateString("en-US", {
                month: "short", day: "numeric", year: "numeric",
            }),
            spotifyUrl: item.track.external_urls.spotify,
        }));

        setCache(userId, 'likedSongs_0_50', songs);
        res.render("dashboard", { user: req.user, songs });
    } catch (error) {
        next(error);
    }
};

// Return the access token for the Spotify Web Playback SDK
const getToken = (req, res) => {
    console.log(
        "Token requested, user:",
        req.user?.id,
        "token exists:",
        !!req.user?.accessToken,
    );
    res.json({ accessToken: req.user.accessToken });
};

// Play a specific track on a device
const playTrack = async (req, res, next) => {
    try {
        const { trackUri, deviceId } = req.body;
        const accessToken = req.user.accessToken;

        const response = await spotifyFetch(
            `https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`,
            {
                method: "PUT",
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ uris: [trackUri] }),
            },
        );

        if (!response.ok && response.status !== 204) {
            const err = await response.json();
            return res.status(response.status).json({ error: err });
        }

        res.json({ ok: true });
    } catch (error) {
        next(error);
    }
};

// Add a track to the end of the queue
const addToQueue = async (req, res, next) => {
    try {
        const { trackUri, deviceId } = req.body;
        const accessToken = req.user.accessToken;

        // device_id is optional — omit it to let Spotify use the active device
        const deviceParam = deviceId ? `&device_id=${deviceId}` : '';
        const response = await spotifyFetch(
            `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(trackUri)}${deviceParam}`,
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                },
            },
        );

        if (!response.ok && response.status !== 204) {
            const err = await response.json();
            return res.status(response.status).json({ error: err });
        }

        res.json({ ok: true });
    } catch (error) {
        next(error);
    }
};

// Helper: convert ms to "3:45" format
function msToMinSec(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}


const getLikedSongs = async (req, res, next) => {
    try {
        const userId        = req.user.id;
        const offset        = parseInt(req.query.offset ?? 0, 10);
        const limit         = parseInt(req.query.limit  ?? 50, 10);

        // Only cache the first page (offset=0) — it's the one fetched on every
        // dashboard load and room join. Scroll pages are cheap one-offs.
        const cacheKey = `likedSongs_${offset}_${limit}`;
        const cached = getCached(userId, cacheKey);
        if (cached) {
            console.log(`[liked] serving offset=${offset} from cache — ${cached.length} songs`);
            return res.json(cached);
        }

        const response = await spotifyFetch(
            `https://api.spotify.com/v1/me/tracks?offset=${offset}&limit=${limit}`,
            { headers: { Authorization: `Bearer ${req.user.accessToken}` } },
        );
        if (!response.ok) throw new Error(`Spotify API error: ${response.status}`);
        const data = await response.json();
        const songs = data.items.map((item) => ({
            id:     item.track.id,
            uri:    item.track.uri,
            name:   item.track.name,
            artist: item.track.artists.map((a) => a.name).join(", "),
            album:  item.track.album.name,
            image:  item.track.album.images[1]?.url || item.track.album.images[0]?.url,
        }));

        setCache(userId, cacheKey, songs);
        res.json(songs);
    } catch (err) {
        next(err);
    }
};

// Fetch all of the user's playlists (paginated, cached per user for 5 min)
const getPlaylists = async (req, res, next) => {
    try {
        const userId      = req.user.id;
        const accessToken = req.user.accessToken;

        const cached = getCached(userId, 'playlists');
        if (cached) {
            console.log('[playlists] serving from cache —', cached.length, 'playlists');
            return res.json(cached);
        }

        const result = await getWithCoalescing(userId, 'playlists', async () => {
            let playlists = [];
            let url = 'https://api.spotify.com/v1/me/playlists?limit=50';
            let pageNum = 0;

            while (url) {
                // Small delay between pages to avoid rapid-fire 429s
                if (pageNum > 0) await sleep(300);
                pageNum++;

                const response = await spotifyFetch(url, {
                    headers: { Authorization: `Bearer ${accessToken}` },
                });
                if (!response.ok) {
                    const retryMs = parseRetryAfter(response.headers?.get?.('Retry-After'));
                    const retrySec = Math.ceil(retryMs / 1000);
                    const msg = response.status === 429
                        ? 'Rate limited by Spotify'
                        : `Spotify API error: ${response.status}`;
                    console.error(`[playlists] ${response.status} — ${msg} (retry in ${retrySec}s)`);
                    throw Object.assign(new Error(msg), { status: response.status, retryAfter: retrySec });
                }
                const data = await response.json();
                console.log('[playlists] page — total:', data.total, 'items:', data.items?.length, 'next:', data.next);
                playlists = playlists.concat(
                    (data.items || []).filter(p => p != null).map(p => ({
                        id:             p.id,
                        name:           p.name,
                        description:    p.description || '',
                        trackCount:     p.tracks?.total ?? p.items?.total ?? 0,  // Feb 2026: tracks→items
                        image:          p.images?.[0]?.url || null,
                        owner:          p.owner?.display_name || '',
                        isSpotifyOwned: p.owner?.id === 'spotify',
                    }))
                );
                url = data.next || null;
            }

            console.log('[playlists] total returned:', playlists.length);
            return playlists;
        });

        setCache(userId, 'playlists', result);
        res.json(result);
    } catch (err) {
        if (err.retryAfter) {
            return res.status(err.status).json({ error: err.message, retryAfter: err.retryAfter });
        }
        next(err);
    }
};

// Fetch all tracks for a given playlist (paginated, cached per playlist per user)
const getPlaylistTracks = async (req, res, next) => {
    try {
        const { playlistId } = req.params;
        const userId      = req.user.id;
        const accessToken = req.user.accessToken;

        const cacheKey = `playlist_${playlistId}`;
        const cached = getCached(userId, cacheKey);
        if (cached) {
            console.log(`[tracks] serving playlist ${playlistId} from cache — ${cached.length} tracks`);
            return res.json(cached);
        }

        const result = await getWithCoalescing(userId, cacheKey, async () => {
            let tracks = [];
            let url = `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=100`;

            while (url) {
                const response = await spotifyFetch(url, {
                    headers: { Authorization: `Bearer ${accessToken}` },
                });
                if (!response.ok) {
                    const errBody = await response.json().catch(() => ({}));
                    const msg = errBody?.error?.message || `Spotify error ${response.status}`;
                    console.error('[tracks] failed — playlist:', playlistId, 'status:', response.status, 'message:', msg);
                    throw Object.assign(new Error(msg), { status: response.status });
                }
                const data = await response.json();
                const valid = data.items
                    .filter(item => item.item && item.item.uri)  // Feb 2026: track → item
                    .map(item => ({
                        id:       item.item.id,
                        uri:      item.item.uri,
                        name:     item.item.name,
                        artist:   item.item.artists.map(a => a.name).join(', '),
                        album:    item.item.album.name,
                        image:    item.item.album.images[1]?.url || item.item.album.images[0]?.url || null,
                        duration: msToMinSec(item.item.duration_ms),
                    }));
                tracks = tracks.concat(valid);
                url = data.next;
            }
            return tracks;
        });

        setCache(userId, cacheKey, result);
        res.json(result);
    } catch (err) {
        if (err.status) {
            return res.status(err.status).json({ error: err.message });
        }
        next(err);
    }
};

module.exports = {
    getDashboard,
    getToken,
    playTrack,
    addToQueue,
    getLikedSongs,
    getPlaylists,
    getPlaylistTracks,
    // Exported for use by roomsController (shared cache + rate-limit-safe fetch)
    getCached,
    setCache,
    spotifyFetch,
};

// Fetch all available Spotify devices for the current user
const getDevices = async (req, res, next) => {
    try {
        const accessToken = req.user.accessToken;
        const response = await spotifyFetch(
            'https://api.spotify.com/v1/me/player/devices',
            { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            return res.status(response.status).json({ error: err?.error?.message || 'Failed to fetch devices' });
        }
        const data = await response.json();
        res.json({ devices: data.devices || [] });
    } catch (err) {
        next(err);
    }
};

// Transfer playback to a specific device
// Body: { deviceId, play? }
const transferPlayback = async (req, res, next) => {
    try {
        const { deviceId, play } = req.body;
        const accessToken = req.user.accessToken;
        const response = await spotifyFetch(
            'https://api.spotify.com/v1/me/player',
            {
                method: 'PUT',
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    device_ids: [deviceId],
                    play: play !== false,
                }),
            },
        );
        if (!response.ok && response.status !== 204) {
            const err = await response.json().catch(() => ({}));
            return res.status(response.status).json({ error: err?.error?.message || 'Transfer failed' });
        }
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
};

module.exports.getDevices = getDevices;
module.exports.transferPlayback = transferPlayback;
