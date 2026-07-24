const puppeteer = require("puppeteer");

let browserInstance = null;

async function getBrowser() {
    try {
        if (browserInstance && browserInstance.isConnected()) return browserInstance;
    } catch (_) {}
    // Launch fresh — previous instance was disconnected or crashed
    browserInstance = await puppeteer.launch({
        headless: "new",
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-extensions",
            "--disable-background-networking",
            "--no-first-run",
            "--disable-default-apps",
        ],
    });
    return browserInstance;
}

function extractPlaylistId(url) {
    const match = url.match(/\/(pl\.[a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
}

function normaliseUrl(url) {
    // Strip javascript: protocol attempts, null bytes, and enforce HTTPS
    return url
        .replace(/^http:\/\//, "https://")
        .replace(/music\.apple\.com\/[a-z]{2}\//, "music.apple.com/us/");
}

function validateAppleMusicUrl(url) {
    if (typeof url !== "string" || url.length > 500) return false;
    // Block non-HTTP schemes (javascript:, data:, etc.)
    if (/^(javascript|data|vbscript|file):/i.test(url)) return false;
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
        if (parsed.hostname !== "music.apple.com") return false;
        if (!parsed.pathname.includes("/playlist/")) return false;
        // Reject URLs with suspicious query params or fragments
        if (parsed.search && parsed.search.length > 1) {
            const params = [...parsed.searchParams.keys()];
            // Apple Music playlist URLs should have no query params
            if (params.length > 0) return false;
        }
        if (parsed.hash && parsed.hash.length > 1) return false;
    } catch {
        return false;
    }
    return true;
}

// Extract iTunes track ID from Apple Music song URL
// e.g. https://music.apple.com/us/song/awkward-freestyle/1617048196 → 1617048196
function extractTrackId(songUrl) {
    const match = songUrl.match(/\/(\d+)(?:\?|$)/);
    return match ? match[1] : null;
}

// Extract song name slug from URL and humanise it
// e.g. "awkward-freestyle" → "Awkward Freestyle"
function slugToName(songUrl) {
    const match = songUrl.match(/\/song\/([^/]+)\/\d+/);
    if (!match) return null;
    return match[1]
        .replace(/-/g, " ")
        .replace(/\b\w/g, c => c.toUpperCase());
}

const getPlaylistTracks = async (req, res, next) => {
    const { url } = req.body;

    if (!validateAppleMusicUrl(url)) {
        return res.status(400).json({ error: "Invalid Apple Music playlist URL" });
    }

    const playlistId = extractPlaylistId(url);
    if (!playlistId) {
        return res.status(400).json({ error: "Could not find playlist ID in URL" });
    }

    const targetUrl = normaliseUrl(url);
    console.log("[apple] fetching:", targetUrl);

    let page;
    try {
        const browser = await getBrowser();
        page = await browser.newPage();

        await page.setUserAgent(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        );

        await page.setRequestInterception(true);
        page.on("request", (req) => {
            const type = req.resourceType();
            if (["image", "stylesheet", "font", "media"].includes(type)) return req.abort();
            req.continue();
        });

        // domcontentloaded, not networkidle2: Apple's client-side app hydrates over
        // the initial DOM and strips these meta tags out once its JS finishes loading,
        // so waiting past hydration finds nothing. The server-rendered HTML already has
        // everything needed.
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

        // ── Parse meta tags ────────────────────────────────────────────────────
        // Apple embeds song URLs in meta tags — attribute names vary but content
        // always contains music.apple.com/us/song/
        const { playlistName, songUrls } = await page.evaluate(() => {
            const metas = [...document.querySelectorAll("meta")];

            // Playlist name — try several known attribute combos
            const titleMeta = metas.find(m =>
                (m.getAttribute("name") === "apple:title" ||
                 m.getAttribute("property") === "og:title" ||
                 m.getAttribute("name") === "og:title") &&
                m.getAttribute("content")
            );
            const playlistName = titleMeta?.getAttribute("content") ||
                document.title.replace(/\s*[-–]\s*Apple Music.*$/, "").trim();

            // Song URLs — grab ANY meta tag whose content contains a song URL.
            // Apple has used og:music:song, music:song, and unnamed tags.
            const seen = new Set();
            const songUrls = metas
                .map(m => m.getAttribute("content") || "")
                .filter(content => {
                    if (!content.includes("music.apple.com") || !content.includes("/song/")) return false;
                    // Deduplicate — each song appears twice (og:music:song + og:music:song:track)
                    const id = content.match(/\/(\d+)(?:\?|$)/)?.[1];
                    if (!id || seen.has(id)) return false;
                    seen.add(id);
                    return true;
                });

            return { playlistName, songUrls };
        });

        console.log(`[apple] found ${songUrls.length} song URLs in meta tags for "${playlistName}"`);

        if (songUrls.length === 0) {
            // Debug: log all meta tag contents so we can see what's there
            const allMetas = await page.evaluate(() =>
                [...document.querySelectorAll("meta")]
                    .map(m => ({
                        name:     m.getAttribute("name"),
                        property: m.getAttribute("property"),
                        content:  m.getAttribute("content")?.slice(0, 100),
                    }))
                    .filter(m => m.content)
            );
            console.log("[apple] all meta tags:", JSON.stringify(allMetas.slice(0, 30), null, 2));
            return res.status(422).json({ error: "No tracks found. The playlist may be private." });
        }

        // ── Batch lookup via iTunes API ────────────────────────────────────────
        // Extract iTunes IDs and look them up 200 at a time (API limit)
        const trackIds = songUrls.map(extractTrackId).filter(Boolean);
        const uniqueIds = [...new Set(trackIds)]; // deduplicate

        console.log(`[apple] looking up ${uniqueIds.length} track IDs via iTunes API`);

        const BATCH = 200;
        const trackMap = {}; // id → { name, artist, album, image }

        for (let i = 0; i < uniqueIds.length; i += BATCH) {
            const batch = uniqueIds.slice(i, i + BATCH);
            const apiUrl = `https://itunes.apple.com/lookup?id=${batch.join(",")}&entity=song`;

            try {
                const apiRes = await fetch(apiUrl);
                const data = await apiRes.json();

                for (const result of (data.results || [])) {
                    if (result.kind !== "song" && result.wrapperType !== "track") continue;
                    const id = String(result.trackId);
                    trackMap[id] = {
                        name:   result.trackName   || "Unknown",
                        artist: result.artistName  || "Unknown Artist",
                        album:  result.collectionName || "",
                        // iTunes gives 100x100 artwork — bump to 300x300
                        image:  result.artworkUrl100?.replace("100x100", "300x300") || null,
                        isrc:   null,
                    };
                }
            } catch (e) {
                console.warn("[apple] iTunes lookup batch failed:", e.message);
            }
        }

        // ── Build track list in original playlist order ────────────────────────
        // songUrls is already in playlist order from the meta tags
        const tracks = songUrls.map((songUrl) => {
            const id = extractTrackId(songUrl);
            if (id && trackMap[id]) return trackMap[id];

            // Fallback: humanise the slug if iTunes didn't return it
            return {
                name:   slugToName(songUrl) || "Unknown",
                artist: "Unknown Artist",
                album:  "",
                image:  null,
                isrc:   null,
            };
        }).filter(t => t.name !== "Unknown");

        console.log(`[apple] returning ${tracks.length} tracks for "${playlistName}"`);
        res.json({ playlistId, name: playlistName, tracks });

    } catch (err) {
        console.error("[apple] error:", err.message);
        next(err);
    } finally {
        if (page) await page.close().catch(() => {});
    }
};

module.exports = { getPlaylistTracks };

// ── Spotify track search (used by guests to queue Apple Music songs) ───────────
// Requires a valid Spotify token stored in roomManager for the given room
const roomManager = require("../roomManager");

const searchSpotifyTrack = async (req, res, next) => {
    const { roomId, name, artist } = req.body;

    if (!roomId || !name) {
        return res.status(400).json({ error: "roomId and name are required" });
    }

    const token = roomManager.getHostToken(roomId);
    if (!token) {
        return res.status(503).json({ error: "No host token available — host must be in the room" });
    }

    try {
        // Build search query: "track:Name artist:Artist" gives best results
        const q = artist
            ? `track:${name} artist:${artist}`
            : `track:${name}`;

        const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=5`;
        const spotRes = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` },
        });

        if (!spotRes.ok) {
            // Token may be expired — clear it
            if (spotRes.status === 401) roomManager.setHostToken(roomId, null);
            return res.status(spotRes.status).json({ error: "Spotify search failed" });
        }

        const data = await spotRes.json();
        const items = data?.tracks?.items || [];

        if (items.length === 0) {
            // Retry with looser query (just track name)
            const looseUrl = `https://api.spotify.com/v1/search?q=${encodeURIComponent(name)}&type=track&limit=3`;
            const looseRes = await fetch(looseUrl, { headers: { Authorization: `Bearer ${token}` } });
            const looseData = await looseRes.json();
            const looseItems = looseData?.tracks?.items || [];

            if (looseItems.length === 0) {
                return res.json({ uri: null, match: null });
            }

            const best = looseItems[0];
            return res.json({
                uri:    best.uri,
                match:  best.name,
                artist: best.artists.map(a => a.name).join(", "),
                image:  best.album.images[1]?.url || best.album.images[0]?.url || null,
            });
        }

        const best = items[0];
        res.json({
            uri:    best.uri,
            match:  best.name,
            artist: best.artists.map(a => a.name).join(", "),
            image:  best.album.images[1]?.url || best.album.images[0]?.url || null,
        });
    } catch (err) {
        next(err);
    }
};

module.exports = { getPlaylistTracks, searchSpotifyTrack };
