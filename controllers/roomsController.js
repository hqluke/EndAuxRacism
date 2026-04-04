const { getCached, setCache, spotifyFetch } = require("./spotifyController");
const roomManager = require("../roomManager");

const getRoom = async (req, res, next) => {
    try {
        const { roomId } = req.params;
        const isAuthenticated = req.isAuthenticated();
        const isHost = isAuthenticated && req.user.id === roomId;

        let songs = [];

        // Only fetch Spotify songs if the user is logged in
        if (isAuthenticated) {
            const userId      = req.user.id;
            const accessToken = req.user.accessToken;

            // Re-use the same cache as the dashboard — avoids a redundant Spotify
            // call when the user navigates from dashboard → room within 5 minutes.
            const cacheKey = 'likedSongs_0_50';
            const cached = getCached(userId, cacheKey);
            if (cached) {
                console.log('[room] serving liked songs from cache —', cached.length, 'songs');
                songs = cached;
            } else {
                const response = await spotifyFetch(
                    "https://api.spotify.com/v1/me/tracks?limit=50",
                    { headers: { Authorization: `Bearer ${accessToken}` } }
                );

                if (response.ok) {
                    const data = await response.json();
                    songs = data.items.map((item) => ({
                        id:       item.track.id,
                        uri:      item.track.uri,
                        name:     item.track.name,
                        artist:   item.track.artists.map((a) => a.name).join(", "),
                        album:    item.track.album.name,
                        image:    item.track.album.images[1]?.url || item.track.album.images[0]?.url || null,
                        duration: msToMinSec(item.track.duration_ms),
                    }));
                    setCache(userId, cacheKey, songs);
                }
            }
        }

        res.render("room", {
            user:   req.user || null,
            roomId,
            isHost,
            songs,
        });
    } catch (err) {
        next(err);
    }
};

function msToMinSec(ms) {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Returns current now-playing for a room — no auth required so guests can call it.
// Includes duration_ms and progress_ms so the guest progress bar works.
const getRoomNowPlaying = (req, res) => {
    const { roomId } = req.params;
    const nowPlaying = roomManager.getNowPlaying(roomId);
    if (!nowPlaying) return res.json(null);
    res.json(nowPlaying);
};

module.exports = { getRoom, getRoomNowPlaying };
