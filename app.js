const path = require("node:path");
const express = require("express");
const session = require("express-session");
const passport = require("passport");
const SpotifyStrategy = require("passport-spotify").Strategy;
const dotenv = require("dotenv");
const http = require("http");
const { Server } = require("socket.io");
const roomManager = require("./roomManager");
dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ─── View Engine ──────────────────────────────────────────────────────────────

app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(path.join(__dirname, "styles")));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || "dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 },
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

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

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
    (req, res) => res.redirect("/spotify/dashboard"),
);

app.get("/logout", (req, res, next) => {
    req.logout((err) => {
        if (err) return next(err);
        res.redirect("/");
    });
});

// ─── App Routes ───────────────────────────────────────────────────────────────

app.get("/", (req, res) => res.render("index"));

// ─── Spotify API Routes (auth required) ──────────────────────────────────────

const spotifyRouter = require("./routes/spotifyRouter");
app.use("/spotify", ensureAuth, spotifyRouter);

// ─── Rooms Routes (no auth required — guests can join) ───────────────────────

const roomsRouter = require("./routes/roomsRouter");
app.use("/rooms", roomsRouter); // No ensureAuth here

// ─── Apple Music Routes (no auth required — guests use this) ─────────────────

const appleMusicRouter = require("./routes/appleMusicRouter");
app.use("/apple", appleMusicRouter);

// ─── Auth Guard ───────────────────────────────────────────────────────────────

function ensureAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.redirect("/");
}

// ─── Socket.io ───────────────────────────────────────────────────────────────

io.on("connection", (socket) => {
    // Guests are allowed — user may be null for unauthenticated connections
    const user = socket.request.session?.passport?.user || null;
    const userId = user?.id || `guest_${socket.id.slice(0, 6)}`;
    const displayName = user?.displayName || "Guest";

    socket.on("join-room", async (roomId) => {
        socket.join(roomId);
        socket.currentRoom = roomId;
        roomManager.ensureRoom(roomId);
        if (user?.accessToken) {
            roomManager.setHostToken(roomId, user.accessToken);
        }
        const roomSockets = await io.in(roomId).fetchSockets();
        const listenerCount = roomSockets.length;
        const queueState = roomManager.getQueue(roomId);
        // Send queue + count to the joiner
        socket.emit("queue-state", { ...queueState, listenerCount });
        // Tell everyone else someone joined
        socket.to(roomId).emit("user-joined", { userId, displayName, listenerCount });
        // Push updated count to the ENTIRE room so the host's label always updates
        io.to(roomId).emit("listener-count", { listenerCount });
    });

    socket.on("queue-add", ({ roomId, song }) => {
        roomManager.addToManualQueue(roomId, song);
        io.to(roomId).emit("queue-state", roomManager.getQueue(roomId));
    });

    // Prepend a song to the front of manualQueue (used by back button)
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

    // FIX: this handler was missing — dragging auto→manual never persisted server-side
    socket.on("queue-move-to-manual", ({ roomId, fromAutoIndex, toManualIndex }) => {
        console.log(`[socket:${roomId}] queue-move-to-manual fromAuto=${fromAutoIndex} toManual=${toManualIndex}`);
        roomManager.moveToManualQueue(roomId, fromAutoIndex, toManualIndex);
        io.to(roomId).emit("queue-state", roomManager.getQueue(roomId));
    });

    socket.on("queue-set-auto", ({ roomId, songs }) => {
        roomManager.setAutoQueue(roomId, songs);
        io.to(roomId).emit("queue-state", roomManager.getQueue(roomId));
    });

    socket.on("queue-advance", ({ roomId }) => {
        const next = roomManager.advance(roomId);
        io.to(roomId).emit("queue-state", roomManager.getQueue(roomId));
        if (next) {
            console.log(`[socket:${roomId}] queue-advance → playing "${next.name}"`);
            io.to(roomId).emit("play-track", next);
        }
    });

    socket.on("queue-replenish", ({ roomId, songs }) => {
        roomManager.replenishAutoQueue(roomId, songs);
        io.to(roomId).emit("queue-state", roomManager.getQueue(roomId));
    });

    socket.on("queue-back", async ({ roomId }) => {
        // Guests can request a back — server prepends nowPlaying to manual queue
        // and emits play-track with the front of history (handled client-side by host)
        // Since guests don't have history, we just signal the host to go back
        socket.to(roomId).emit("guest-request-back");
    });

    socket.on("now-playing-broadcast", ({ roomId, song }) => {
        socket.to(roomId).emit("now-playing", song);
    });

    socket.on("disconnect", async () => {
        if (socket.currentRoom) {
            const roomSockets = await io.in(socket.currentRoom).fetchSockets();
            const listenerCount = roomSockets.length;
            socket.to(socket.currentRoom).emit("user-left", { userId, displayName, listenerCount });
            // Push updated count to remaining room members
            io.to(socket.currentRoom).emit("listener-count", { listenerCount });
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
