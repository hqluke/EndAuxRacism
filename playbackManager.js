/**
 * playbackManager.js
 *
 * Server-side playback controller. Polls Spotify's /me/player every 3 seconds
 * for each active room. When a track is near its end (~5s out), the server
 * advances the room queue and calls PUT /me/player/play directly — completely
 * independent of whether the host's browser tab is open or their phone screen
 * is on.
 *
 * Token refresh is handled transparently: when a 401 is returned, we use the
 * stored refreshToken to get a new accessToken and retry.
 */

const roomManager = require('./roomManager');

// ── Config ────────────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS  = 3000;  // how often we check Spotify
const NEAR_END_MS       = 5000;  // how many ms from end to trigger advance
const TOKEN_REFRESH_URL = 'https://accounts.spotify.com/api/token';

// ── State ─────────────────────────────────────────────────────────────────────
// Map of roomId → { intervalId, lastUri, advanceInFlight }
const activePollers = new Map();

// io instance — set by init()
let _io = null;

function init(io) {
    _io = io;
}

// ── Token refresh ─────────────────────────────────────────────────────────────
async function refreshAccessToken(roomId) {
    const room = roomManager.ensureRoom(roomId);
    if (!room.refreshToken) {
        console.warn(`[playback:${roomId}] no refreshToken stored — cannot refresh`);
        return null;
    }

    const clientId     = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
    const basic        = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    try {
        const res = await fetch(TOKEN_REFRESH_URL, {
            method: 'POST',
            headers: {
                Authorization:  `Basic ${basic}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                grant_type:    'refresh_token',
                refresh_token: room.refreshToken,
            }),
        });

        if (!res.ok) {
            console.error(`[playback:${roomId}] token refresh failed: ${res.status}`);
            return null;
        }

        const data = await res.json();
        const newToken = data.access_token;

        // Spotify may rotate the refresh token — store the new one if present
        if (data.refresh_token) {
            roomManager.setRefreshToken(roomId, data.refresh_token);
        }

        roomManager.setHostToken(roomId, newToken);
        console.log(`[playback:${roomId}] token refreshed successfully`);
        return newToken;
    } catch (e) {
        console.error(`[playback:${roomId}] token refresh error:`, e.message);
        return null;
    }
}

// ── Spotify API helpers ───────────────────────────────────────────────────────
async function spotifyGet(roomId, path) {
    let token = roomManager.getHostToken(roomId);
    if (!token) return null;

    let res = await fetch(`https://api.spotify.com/v1${path}`, {
        headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 401) {
        token = await refreshAccessToken(roomId);
        if (!token) return null;
        res = await fetch(`https://api.spotify.com/v1${path}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
    }

    if (res.status === 204) return null; // no content (nothing playing)
    if (!res.ok) return null;
    return res.json();
}

async function spotifyPlay(roomId, trackUri) {
    let token = roomManager.getHostToken(roomId);
    if (!token) return false;

    const body = JSON.stringify({ uris: [trackUri] });

    let res = await fetch('https://api.spotify.com/v1/me/player/play', {
        method:  'PUT',
        headers: {
            Authorization:  `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body,
    });

    if (res.status === 401) {
        token = await refreshAccessToken(roomId);
        if (!token) return false;
        res = await fetch('https://api.spotify.com/v1/me/player/play', {
            method:  'PUT',
            headers: {
                Authorization:  `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body,
        });
    }

    return res.ok || res.status === 204;
}

// ── Core poll tick ────────────────────────────────────────────────────────────
async function pollTick(roomId) {
    const poller = activePollers.get(roomId);
    if (!poller) return;

    const state = await spotifyGet(roomId, '/me/player');
    if (!state || !state.item) return;

    const uri      = state.item.uri;
    const pos      = state.progress_ms  || 0;
    const duration = state.item.duration_ms || 0;
    const playing  = state.is_playing;

    // ── Broadcast now-playing to all room members ─────────────────────────────
    if (uri !== poller.lastUri) {
        poller.lastUri         = uri;
        poller.advanceInFlight = false; // new track confirmed — reset guard

        const songData = {
            name:        state.item.name,
            artist:      state.item.artists.map(a => a.name).join(', '),
            image:       state.item.album?.images?.[0]?.url || '',
            uri,
            duration_ms: duration,
            progress_ms: pos,
        };

        roomManager.setNowPlaying(roomId, songData);
        console.log(`[playback:${roomId}] now playing: "${state.item.name}"`);

        if (_io) _io.to(roomId).emit('now-playing', songData);
    }

    // ── Periodic progress sync for guests ─────────────────────────────────────
    if (_io) {
        _io.to(roomId).emit('progress-sync', {
            uri,
            progress_ms: pos,
            duration_ms: duration,
        });
    }

    // ── Near-end: advance queue and play next song directly ───────────────────
    if (
        playing &&
        duration > 0 &&
        pos >= duration - NEAR_END_MS &&
        !poller.advanceInFlight
    ) {
        poller.advanceInFlight = true;

        const next = roomManager.advance(roomId);
        if (next) {
            console.log(`[playback:${roomId}] near-end — playing next: "${next.name}"`);
            const ok = await spotifyPlay(roomId, next.uri);
            if (ok) {
                if (_io) {
                    _io.to(roomId).emit('play-track', next);
                    _io.to(roomId).emit('queue-state', roomManager.getQueue(roomId));
                }
            } else {
                // Play failed — put the song back at the front of the queue
                console.warn(`[playback:${roomId}] spotifyPlay failed — requeueing "${next.name}"`);
                roomManager.prependToManualQueue(roomId, next);
                poller.advanceInFlight = false;
            }
        } else {
            console.log(`[playback:${roomId}] near-end — queue empty, nothing to play next`);
            poller.advanceInFlight = false;
        }
    }
}

// ── Start / stop per room ─────────────────────────────────────────────────────
function startPolling(roomId) {
    if (activePollers.has(roomId)) return; // already running

    console.log(`[playback:${roomId}] starting server-side polling`);
    const poller = {
        lastUri:         null,
        advanceInFlight: false,
        intervalId:      null,
    };

    poller.intervalId = setInterval(() => pollTick(roomId), POLL_INTERVAL_MS);
    activePollers.set(roomId, poller);
}

function stopPolling(roomId) {
    const poller = activePollers.get(roomId);
    if (!poller) return;

    console.log(`[playback:${roomId}] stopping server-side polling`);
    clearInterval(poller.intervalId);
    activePollers.delete(roomId);
}

function isPolling(roomId) {
    return activePollers.has(roomId);
}

// Reset lastUri so the server re-broadcasts now-playing after a manual play
function resetLastUri(roomId) {
    const poller = activePollers.get(roomId);
    if (poller) {
        poller.lastUri         = null;
        poller.advanceInFlight = false;
    }
}

module.exports = { init, startPolling, stopPolling, isPolling, resetLastUri };
