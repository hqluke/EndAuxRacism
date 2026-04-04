/**
 * roomManager.js
 * In-memory store for rooms and their queues.
 *
 * Each room has two queues:
 *   - autoQueue:   songs set when the user hits play (the "up next" list)
 *   - manualQueue: songs explicitly queued by listeners (played first)
 */

const rooms = new Map();

function ensureRoom(roomId) {
    if (!rooms.has(roomId)) {
        rooms.set(roomId, {
            autoQueue:    [],
            manualQueue:  [],
            hostToken:    null,  // Spotify access token from the host
            refreshToken: null,  // Spotify refresh token — used for server-side token refresh
            nowPlaying:   null,  // { name, artist, image, uri } — last known playing track
        });
    }
    return rooms.get(roomId);
}

function setHostToken(roomId, token) {
    const room = ensureRoom(roomId);
    room.hostToken = token;
}

function getHostToken(roomId) {
    return rooms.get(roomId)?.hostToken || null;
}

function setRefreshToken(roomId, token) {
    const room = ensureRoom(roomId);
    room.refreshToken = token;
}

function getRefreshToken(roomId) {
    return rooms.get(roomId)?.refreshToken || null;
}

function setNowPlaying(roomId, song) {
    const room = ensureRoom(roomId);
    room.nowPlaying = song;
}

function getNowPlaying(roomId) {
    return rooms.get(roomId)?.nowPlaying || null;
}

function getQueue(roomId) {
    const room = ensureRoom(roomId);
    return {
        autoQueue: [...room.autoQueue],
        manualQueue: [...room.manualQueue],
    };
}

function addToManualQueue(roomId, song) {
    const room = ensureRoom(roomId);
    room.manualQueue.push(song);
    console.log(`[queue:${roomId}] ADD manual ← "${song.name}" | manual=${room.manualQueue.length} auto=${room.autoQueue.length}`);
}

function prependToManualQueue(roomId, song) {
    const room = ensureRoom(roomId);
    room.manualQueue.unshift(song);
    console.log(`[queue:${roomId}] PREPEND manual ← "${song.name}" | manual=${room.manualQueue.length} auto=${room.autoQueue.length}`);
}

function removeFromQueue(roomId, queueType, index) {
    const room = ensureRoom(roomId);
    const key  = queueType === 'manual' ? 'manualQueue' : 'autoQueue';
    if (room[key]) {
        const [removed] = room[key].splice(index, 1);
        console.log(`[queue:${roomId}] REMOVE ${queueType}[${index}] "${removed?.name}" | manual=${room.manualQueue.length} auto=${room.autoQueue.length}`);
    }
}

function reorderQueue(roomId, queueType, fromIndex, toIndex) {
    const room  = ensureRoom(roomId);
    const key   = queueType === 'manual' ? 'manualQueue' : 'autoQueue';
    const queue = room[key];
    if (!queue) return;
    const [item] = queue.splice(fromIndex, 1);
    queue.splice(toIndex, 0, item);
    console.log(`[queue:${roomId}] REORDER ${queueType} [${fromIndex}→${toIndex}] "${item?.name}"`);
}

function setAutoQueue(roomId, songs) {
    const room = ensureRoom(roomId);
    room.autoQueue = [...songs];
    console.log(`[queue:${roomId}] SET auto (${songs.length} songs) — first: "${songs[0]?.name}"`);
}

function setManualQueue(roomId, songs) {
    const room = ensureRoom(roomId);
    room.manualQueue = [...songs];
    console.log(`[queue:${roomId}] SET manual (${songs.length} songs) — shuffled`);
}

/**
 * Advance the queue — manual queue takes priority over auto queue.
 * Returns the next song object, or null if both queues are empty.
 */
function advance(roomId) {
    const room = ensureRoom(roomId);
    let next = null;
    let source = null;
    if (room.manualQueue.length > 0) {
        next = room.manualQueue.shift();
        source = 'manual';
    } else if (room.autoQueue.length > 0) {
        next = room.autoQueue.shift();
        source = 'auto';
    }
    if (next) {
        console.log(`[queue:${roomId}] ADVANCE from ${source} → now playing "${next.name}" | manual=${room.manualQueue.length} auto=${room.autoQueue.length}`);
        console.log(`[queue:${roomId}]   manual queue: [${room.manualQueue.map(s => `"${s.name}"`).join(', ')}]`);
        console.log(`[queue:${roomId}]   auto queue:   [${room.autoQueue.slice(0, 5).map(s => `"${s.name}"`).join(', ')}${room.autoQueue.length > 5 ? '...' : ''}]`);
    } else {
        console.log(`[queue:${roomId}] ADVANCE — both queues empty`);
    }
    return next;
}

/**
 * Append more songs to the auto queue (called when it runs low).
 * Avoids adding duplicates already present in the queue.
 */
function replenishAutoQueue(roomId, songs) {
    const room = ensureRoom(roomId);
    const existingUris = new Set(room.autoQueue.map((s) => s.uri));
    let added = 0;
    for (const song of songs) {
        if (!existingUris.has(song.uri)) {
            room.autoQueue.push(song);
            existingUris.add(song.uri);
            added++;
        }
    }
    console.log(`[queue:${roomId}] REPLENISH +${added} songs | auto=${room.autoQueue.length}`);
}

/**
 * Move a song from the auto queue into the manual queue.
 */
function moveToManualQueue(roomId, fromAutoIndex, toManualIndex) {
    const room = ensureRoom(roomId);
    if (fromAutoIndex < 0 || fromAutoIndex >= room.autoQueue.length) {
        console.warn(`[queue:${roomId}] MOVE-TO-MANUAL failed — autoIndex ${fromAutoIndex} out of range (auto=${room.autoQueue.length})`);
        return null;
    }
    const [song] = room.autoQueue.splice(fromAutoIndex, 1);
    const insertAt = Math.min(toManualIndex, room.manualQueue.length);
    room.manualQueue.splice(insertAt, 0, song);
    console.log(`[queue:${roomId}] MOVE-TO-MANUAL auto[${fromAutoIndex}] → manual[${insertAt}] "${song.name}" | manual=${room.manualQueue.length} auto=${room.autoQueue.length}`);
    return song;
}

module.exports = {
    ensureRoom,
    getQueue,
    addToManualQueue,
    prependToManualQueue,
    removeFromQueue,
    reorderQueue,
    setAutoQueue,
    setManualQueue,
    advance,
    replenishAutoQueue,
    moveToManualQueue,
    setHostToken,
    getHostToken,
    setRefreshToken,
    getRefreshToken,
    setNowPlaying,
    getNowPlaying,
};
