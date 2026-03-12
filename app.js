const path = require("node:path");
const express = require("express");
const session = require("express-session");
const passport = require("passport");
const SpotifyStrategy = require("passport-spotify").Strategy;
const dotenv = require("dotenv");
const http = require("http");
const { Server } = require("socket.io");
const roomManager = require("./roomManager");
const roomsRouter = require("./routes/roomsRouter");
dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ─── View Engine ──────────────────────────────────────────────────────────────

app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, "public")));
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

// Share express session with socket.io so we can auth socket connections
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
                avatar: profile.photos?.[0] || null,
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

// ─── Spotify API Routes ───────────────────────────────────────────────────────

const spotifyRouter = require("./routes/spotifyRouter");
app.use("/spotify", ensureAuth, spotifyRouter);

// ─── Auth Guard ───────────────────────────────────────────────────────────────

function ensureAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.redirect("/");
}

// ─── Socket.io — Queue Sync ───────────────────────────────────────────────────

io.on("connection", (socket) => {
    const user = socket.request.session?.passport?.user;
    if (!user) return socket.disconnect();

    const userId = user.id;
    const displayName = user.displayName;

    // Join a room
    socket.on("join-room", (roomId) => {
        socket.join(roomId);
        socket.currentRoom = roomId;

        // Create room if it doesn't exist
        roomManager.ensureRoom(roomId);

        // Send current queue state to the joining user
        socket.emit("queue-state", roomManager.getQueue(roomId));

        // Notify others
        socket.to(roomId).emit("user-joined", { userId, displayName });
    });

    // Add to manual queue
    socket.on("queue-add", ({ roomId, song }) => {
        roomManager.addToManualQueue(roomId, song);
        io.to(roomId).emit("queue-state", roomManager.getQueue(roomId));
    });

    // Remove from queue
    socket.on("queue-remove", ({ roomId, queueType, index }) => {
        roomManager.removeFromQueue(roomId, queueType, index);
        io.to(roomId).emit("queue-state", roomManager.getQueue(roomId));
    });

    // Reorder within a queue
    socket.on("queue-reorder", ({ roomId, queueType, fromIndex, toIndex }) => {
        roomManager.reorderQueue(roomId, queueType, fromIndex, toIndex);
        io.to(roomId).emit("queue-state", roomManager.getQueue(roomId));
    });

    // Set the auto queue (when play is pressed on a song)
    socket.on("queue-set-auto", ({ roomId, songs }) => {
        roomManager.setAutoQueue(roomId, songs);
        io.to(roomId).emit("queue-state", roomManager.getQueue(roomId));
    });

    // Song finished — advance the queue
    socket.on("queue-advance", ({ roomId }) => {
        const next = roomManager.advance(roomId);
        io.to(roomId).emit("queue-state", roomManager.getQueue(roomId));
        if (next) io.to(roomId).emit("play-track", next.uri);
    });

    // Replenish auto queue when it gets low
    socket.on("queue-replenish", ({ roomId, songs }) => {
        roomManager.replenishAutoQueue(roomId, songs);
        io.to(roomId).emit("queue-state", roomManager.getQueue(roomId));
    });

    socket.on("disconnect", () => {
        if (socket.currentRoom) {
            socket
                .to(socket.currentRoom)
                .emit("user-left", { userId, displayName });
        }
    });
});

// ─── Error Handler ────────────────────────────────────────────────────────────

app.use((err, req, res, next) => {
    console.error("Error:", err);
    res.status(500).send("Something went wrong — check server logs");
});

app.use("/room", ensureAuth, roomsRouter);

// ─── Start (use server.listen not app.listen for socket.io) ──────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`App listening on port ${PORT}`));
