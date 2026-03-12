const getRoom = async (req, res, next) => {
    try {
        const { roomId } = req.params;
        const isAuthenticated = req.isAuthenticated();
        const isHost = isAuthenticated && req.user.id === roomId;

        let songs = [];

        // Only fetch Spotify songs if the user is logged in
        if (isAuthenticated) {
            const accessToken = req.user.accessToken;
            const response = await fetch(
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

module.exports = { getRoom };
