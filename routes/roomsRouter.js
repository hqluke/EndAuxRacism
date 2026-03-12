const express = require("express");
const router = express.Router();
const roomsController = require("../controllers/roomsController");

// Create or join a room — for now just renders the room page
// roomId defaults to the host's Spotify ID
router.get("/:roomId", roomsController.getRoom);

module.exports = router;
