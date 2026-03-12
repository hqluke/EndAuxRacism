const express = require("express");
const router = express.Router();
const spotifyController = require("../controllers/spotifyController");

router.get("/dashboard", spotifyController.getDashboard);
router.get("/token", spotifyController.getToken);
router.post("/play", spotifyController.playTrack);
router.post("/queue", spotifyController.addToQueue);

module.exports = router;
