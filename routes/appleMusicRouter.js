const express = require("express");
const router  = express.Router();
const appleMusicController = require("../controllers/appleMusicController");

// POST /apple/playlist  — body: { url: "https://music.apple.com/..." }
// No auth required — guests use this
router.post("/playlist", appleMusicController.getPlaylistTracks);

module.exports = router;
