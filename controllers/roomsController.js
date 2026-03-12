const getRoom = async (req, res, next) => {
    try {
        const { roomId } = req.params;
        const accessToken = req.user.accessToken;

        // Fetch the user's liked songs to populate the song browser in the room
        const response = await fetch(
            "https://api.spotify.com/v1/me/tracks?limit=50",
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        if (!response.ok) {
            throw new Error(`Spotify API error: ${response.status}`);
        }

        const data = await response.json();

        const songs = data.items.map((item) => ({
            id:       item.track.id,
            uri:      item.track.uri,
            name:     item.track.name,
            artist:   item.track.artists.map((a) => a.name).join(", "),
            album:    item.track.album.name,
            image:    item.track.album.images[1]?.url || item.track.album.images[0]?.url || null,
            duration: msToMinSec(item.track.duration_ms),
        }));

        res.render("room", {
            user:   req.user,
            roomId,
            isHost: req.user.id === roomId,
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
