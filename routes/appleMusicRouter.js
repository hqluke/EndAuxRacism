const express = require("express");
const router  = express.Router();
const appleMusicController = require("../controllers/appleMusicController");

// POST /apple/playlist  — body: { url }
router.post("/playlist", appleMusicController.getPlaylistTracks);

// POST /apple/search    — body: { roomId, name, artist }
// No auth required — uses host's token stored in roomManager
router.post("/search", appleMusicController.searchSpotifyTrack);

module.exports = router;
