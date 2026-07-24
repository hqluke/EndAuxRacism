const path = require("node:path");
const express = require("express");
const session = require("express-session");
const passport = require("passport");
const SpotifyStrategy = require("passport-spotify").Strategy;
const dotenv = require("dotenv");
const http = require("http");
const { Server } = require("socket.io");
const roomManager = require("./roomManager");
const playbackManager = require("./playbackManager");
dotenv.config();

if (!process.env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET environment variable is required");
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Init playbackManager with the io instance so it can emit to rooms
playbackManager.init(io);

// ─── View Engine ──────────────────────────────────────────────────────────────

app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(path.join(__dirname, "styles")));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 24 * 60 * 60 * 1000,
        httpOnly: true,
        // secure: false because Railway terminates SSL at the proxy and forwards HTTP.
        // With secure: true, the browser refuses to store the cookie over HTTP.
        // If deploying behind a reverse proxy that sets X-Forwarded-Proto, add
        // app.set('trust proxy', 1) and change this to secure: 'auto'.
        secure: false,
        sameSite: "lax",
    },
});

app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

// Share session with socket.io
io.engine.use(sessionMiddleware);
io.engine.use(passport.initialize());
io.engine.use(passport.session());

app.use((req, res, next) => {
    res.locals.currentUser = req.user || null;
    next();
});

// ─── Spotify Strategy ────────────────────────────────────────────────────────

passport.use(
    new SpotifyStrategy(
        {
            clientID: process.env.SPOTIFY_CLIENT_ID,
            clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
            callbackURL:
                process.env.SPOTIFY_REDIRECT_URI ||
                "http://127.0.0.1:3000/auth/spotify/callback",
        },
        (accessToken, refreshToken, expires_in, profile, done) => {
            const user = {
                id: profile.id,
                displayName: profile.displayName,
                email: profile.emails?.[0]?.value || null,
                avatar: profile.photos?.[0]?.url || null,
                accessToken,
                refreshToken,
            };
            return done(null, user);
        },
    ),
);

// Serialize the full user object (including tokens) into the in-memory session.
// The session cookie is httpOnly + secure + sameSite=lax, so tokens are protected in transit.
// If a session store (Redis, DB) is ever added, tokens MUST be excluded from serialization
// and fetched from encrypted storage instead.
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// ─── App Routes ───────────────────────────────────────────────────────────────

app.get("/", (req, res) => res.render("index"));

// ─── Spotify API Routes (auth required) ──────────────────────────────────────

const spotifyRouter = require("./routes/spotifyRouter");
app.use("/spotify", ensureAuth, spotifyRouter);

// ─── Rooms Routes (no auth required — guests can join) ───────────────────────

const roomsRouter = require("./routes/roomsRouter");
app.use("/rooms", roomsRouter);

// ─── Apple Music Routes (no auth required — guests use this) ─────────────────

const appleMusicRouter = require("./routes/appleMusicRouter");
app.use("/apple", appleMusicRouter);

// ─── Auth Guard ───────────────────────────────────────────────────────────────

function ensureAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.redirect("/");
}

// ─── Auth Routes ─────────────────────────────────────────────────────────────

app.get(
    "/auth/spotify",
    passport.authenticate("spotify", {
        scope: [
            "user-read-email",
            "user-read-private",
            "user-library-read",
            "playlist-read-private",
            "playlist-read-collaborative",
            "streaming",
            "user-modify-playback-state",
            "user-read-playback-state",
        ],
    }),
);

app.get(
    "/auth/spotify/callback",
    passport.authenticate("spotify", { failureRedirect: "/" }),
    (req, res) => res.redirect(`/rooms/${req.user.id}`),
);

app.get("/logout", (req, res, next) => {
    req.logout((err) => {
        if (err) return next(err);
        res.redirect("/");
    });
});


// ─── Socket.io ───────────────────────────────────────────────────────────────

io.on("connection", (socket) => {
    const user = socket.request.session?.passport?.user || null;
    const userId = user?.id || `guest_${socket.id.slice(0, 6)}`;
    const displayName = user?.displayName || "Guest";

    socket.on("join-room", async (roomId) => {
        socket.join(roomId);
        socket.currentRoom = roomId;
        roomManager.ensureRoom(roomId);

        // Only store tokens for the host (the user whose ID matches the roomId).
        // Storing tokens for Spotify-authenticated guests would overwrite the host's
        // token, causing the server-side poller to play on the guest's account and
        // breaking token refresh for the host.
        if (user?.id === roomId) {
            if (user.accessToken)  roomManager.setHostToken(roomId, user.accessToken);
            if (user.refreshToken) roomManager.setRefreshToken(roomId, user.refreshToken);
        }

        // Start server-side playback polling for this room if not already running
        if (user?.id === roomId) {
            playbackManager.startPolling(roomId);
        }

        const roomSockets = await io.in(roomId).fetchSockets();
        const listenerCount = roomSockets.length;
        const queueState = roomManager.getQueue(roomId);

        // Send queue + count to the joiner
        socket.emit("queue-state", { ...queueState, listenerCount });

        // Send current now-playing to the joiner so they see what's playing immediately
        const nowPlaying = roomManager.getNowPlaying(roomId);
        if (nowPlaying) socket.emit("now-playing", nowPlaying);

        socket.to(roomId).emit("user-joined", { userId, displayName, listenerCount });
        io.to(roomId).emit("listener-count", { listenerCount });
    });

    socket.on("queue-add", ({ roomId, song }) => {
        roomManager.addToManualQueue(roomId, song);
        io.to(roomId).emit("queue-state", roomManager.getQueue(roomId));
    });

    socket.on("queue-prepend", ({ roomId, song }) => {
        console.log(`[socket:${roomId}] queue-prepend "${song?.name}"`);
        roomManager.prependToManualQueue(roomId, song);
        io.to(roomId).emit("queue-state", roomManager.getQueue(roomId));
    });

    socket.on("queue-remove", ({ roomId, queueType, index }) => {
        roomManager.removeFromQueue(roomId, queueType, index);
        io.to(roomId).emit("queue-state", roomManager.getQueue(roomId));
    });

    socket.on("queue-reorder", ({ roomId, queueType, fromIndex, toIndex }) => {
        roomManager.reorderQueue(roomId, queueType, fromIndex, toIndex);
        io.to(roomId).emit("queue-state", roomManager.getQueue(roomId));
    });

    socket.on("queue-move-to-manual", ({ roomId, fromAutoIndex, toManualIndex }) => {
        console.log(`[socket:${roomId}] queue-move-to-manual fromAuto=${fromAutoIndex} toManual=${toManualIndex}`);
        roomManager.moveToManualQueue(roomId, fromAutoIndex, toManualIndex);
        io.to(roomId).emit("queue-state", roomManager.getQueue(roomId));
    });

    socket.on("queue-set-auto", ({ roomId, songs }) => {
        roomManager.setAutoQueue(roomId, songs);
        io.to(roomId).emit("queue-state", roomManager.getQueue(roomId));
    });

    socket.on("queue-set-manual", ({ roomId, songs }) => {
        roomManager.setManualQueue(roomId, songs);
        io.to(roomId).emit("queue-state", roomManager.getQueue(roomId));
    });

    // queue-advance is now only called from the client for manual skips (next button,
    // guest skip request). Server-side polling handles near-end advancement automatically.
    socket.on("queue-advance", ({ roomId }) => {
        const next = roomManager.advance(roomId);
        io.to(roomId).emit("queue-state", roomManager.getQueue(roomId));
        if (next) {
            console.log(`[socket:${roomId}] queue-advance → playing "${next.name}"`);
            io.to(roomId).emit("play-track", next);
            // Reset poller state so it picks up the new track immediately
            playbackManager.resetLastUri(roomId);
        }
    });

    socket.on("queue-replenish", ({ roomId, songs }) => {
        roomManager.replenishAutoQueue(roomId, songs);
        io.to(roomId).emit("queue-state", roomManager.getQueue(roomId));
    });

    socket.on("queue-back", async ({ roomId }) => {
        socket.to(roomId).emit("guest-request-back");
    });

    // Host broadcasts what's now playing so guests and server stay in sync
    socket.on("now-playing-broadcast", ({ roomId, song }) => {
        roomManager.setNowPlaying(roomId, song);
        // Reset poller's lastUri so it doesn't think this is a new track on next poll
        playbackManager.resetLastUri(roomId);
        socket.to(roomId).emit("now-playing", song);
    });

    socket.on("disconnect", async () => {
        if (socket.currentRoom) {
            const roomSockets = await io.in(socket.currentRoom).fetchSockets();
            const listenerCount = roomSockets.length;
            socket.to(socket.currentRoom).emit("user-left", { userId, displayName, listenerCount });
            io.to(socket.currentRoom).emit("listener-count", { listenerCount });

            // If the room is now empty, stop polling to save resources
            if (listenerCount === 0) {
                playbackManager.stopPolling(socket.currentRoom);
            }
        }
    });
});

// ─── Error Handler ────────────────────────────────────────────────────────────

app.use((err, req, res, next) => {
    console.error("Error:", err);
    res.status(500).send("Something went wrong — check server logs");
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`App listening on port ${PORT}`));
