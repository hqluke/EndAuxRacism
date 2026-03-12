const path = require("node:path");
const express = require("express");
const session = require("express-session");
const passport = require("passport");
const SpotifyStrategy = require("passport-spotify").Strategy;
const dotenv = require("dotenv");
dotenv.config();

const app = express();

// ─── View Engine ──────────────────────────────────────────────────────────────

app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use(
    session({
        secret: process.env.SESSION_SECRET || "dev-secret-change-me",
        resave: false,
        saveUninitialized: false,
        cookie: {
            maxAge: 24 * 60 * 60 * 1000,
        },
    }),
);

app.use(passport.initialize());
app.use(passport.session());

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

passport.serializeUser((user, done) => {
    done(null, user);
});

passport.deserializeUser((user, done) => {
    done(null, user);
});

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
            "streaming", // Required for Web Playback SDK
            "user-modify-playback-state", // Required to play/queue/skip
            "user-read-playback-state", // Required to read current state
        ],
    }),
);

app.get(
    "/auth/spotify/callback",
    passport.authenticate("spotify", { failureRedirect: "/" }),
    (req, res) => {
        res.redirect("/spotify/dashboard");
    },
);

app.get("/logout", (req, res, next) => {
    req.logout((err) => {
        if (err) return next(err);
        res.redirect("/");
    });
});

// ─── App Routes ───────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
    res.render("index");
});

// ─── Spotify API Routes ───────────────────────────────────────────────────────

const spotifyRouter = require("./routes/spotifyRouter");
app.use("/spotify", ensureAuth, spotifyRouter);

// ─── Rooms Routes ─────────────────────────────────────────────────────────────

// const roomsRouter = require("./routes/roomsRouter");
// app.use("/rooms", ensureAuth, roomsRouter);

// ─── Auth Guard ───────────────────────────────────────────────────────────────

function ensureAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.redirect("/");
}

// ─── Error Handler ────────────────────────────────────────────────────────────

app.use((err, req, res, next) => {
    console.error("Error:", err);
    res.status(500).send("Something went wrong — check server logs");
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`App listening on port ${PORT}`);
});
