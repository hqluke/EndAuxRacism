const getDashboard = async (req, res, next) => {
    try {
        const accessToken = req.user.accessToken;

        // Fetch 50 most recent liked songs (more to search through)
        const response = await fetch(
            "https://api.spotify.com/v1/me/tracks?limit=50",
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                },
            },
        );

        if (!response.ok) {
            throw new Error(`Spotify API error: ${response.status}`);
        }

        const data = await response.json();

        const songs = data.items.map((item) => ({
            id: item.track.id,
            uri: item.track.uri,
            name: item.track.name,
            artist: item.track.artists.map((a) => a.name).join(", "),
            album: item.track.album.name,
            image:
                item.track.album.images[1]?.url ||
                item.track.album.images[0]?.url,
            duration: msToMinSec(item.track.duration_ms),
            addedAt: new Date(item.added_at).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
            }),
            spotifyUrl: item.track.external_urls.spotify,
        }));

        res.render("dashboard", {
            user: req.user,
            songs,
        });
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

        const response = await fetch(
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

        const response = await fetch(
            `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(trackUri)}&device_id=${deviceId}`,
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
        const { offset = 0, limit = 50 } = req.query;
        const response = await fetch(
            `https://api.spotify.com/v1/me/tracks?offset=${offset}&limit=${limit}`,
            { headers: { Authorization: `Bearer ${req.user.accessToken}` } },
        );
        const data = await response.json();
        const songs = data.items.map((item) => ({
            id: item.track.id,
            uri: item.track.uri,
            name: item.track.name,
            artist: item.track.artists.map((a) => a.name).join(", "),
            album: item.track.album.name,
            image:
                item.track.album.images[1]?.url ||
                item.track.album.images[0]?.url,
        }));
        res.json(songs);
    } catch (err) {
        next(err);
    }
};

// Fetch all of the user's playlists (paginated, returns everything)
const getPlaylists = async (req, res, next) => {
    try {
        const accessToken = req.user.accessToken;
        let playlists = [];
        let url = 'https://api.spotify.com/v1/me/playlists?limit=50';

        while (url) {
            const response = await fetch(url, {
                headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (!response.ok) throw new Error(`Spotify API error: ${response.status}`);
            const data = await response.json();
            console.log('[playlists] page — total:', data.total, 'items:', data.items?.length, 'next:', data.next);
            playlists = playlists.concat((data.items || []).filter(p => p != null).map(p => ({
                id:          p.id,
                name:        p.name,
                description: p.description || '',
                trackCount:  p.tracks?.total ?? 0,
                image:       p.images?.[0]?.url || null,
                owner:          p.owner?.display_name || '',
                isSpotifyOwned: p.owner?.id === 'spotify',
            })));
            url = data.next || null;
        }

        console.log('[playlists] total returned:', playlists.length);

        res.json(playlists);
    } catch (err) {
        next(err);
    }
};

// Fetch all tracks for a given playlist (paginated, returns everything)
const getPlaylistTracks = async (req, res, next) => {
    try {
        const { playlistId } = req.params;
        const accessToken = req.user.accessToken;
        let tracks = [];
        let url = `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=100`;

        while (url) {
            const response = await fetch(url, {
                headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (!response.ok) {
                const errBody = await response.json().catch(() => ({}));
                console.error('[tracks] failed — playlist:', playlistId, 'status:', response.status, 'message:', errBody?.error?.message);
                return res.status(response.status).json({ error: errBody?.error?.message || `Spotify error ${response.status}` });
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

        res.json(tracks);
    } catch (err) {
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
};
