const express = require("express");
const router = express.Router();
const spotifyController = require("../controllers/spotifyController");

router.get("/dashboard", spotifyController.getDashboard);
router.get("/token", spotifyController.getToken);
router.post("/play", spotifyController.playTrack);
router.post("/queue", spotifyController.addToQueue);
router.get("/liked", spotifyController.getLikedSongs);
router.get("/playlists", spotifyController.getPlaylists);
router.get("/playlists/:playlistId/tracks", spotifyController.getPlaylistTracks);

module.exports = router;
