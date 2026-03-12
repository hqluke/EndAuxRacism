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
    console.log('Token requested, user:', req.user?.id, 'token exists:', !!req.user?.accessToken);
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

module.exports = { getDashboard, getToken, playTrack, addToQueue };
