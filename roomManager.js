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
            autoQueue: [],
            manualQueue: [],
        });
    }
    return rooms.get(roomId);
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
}

function removeFromQueue(roomId, queueType, index) {
    const room = ensureRoom(roomId);
    const key = queueType === "manual" ? "manualQueue" : "autoQueue";
    if (room[key]) {
        room[key].splice(index, 1);
    }
}

function reorderQueue(roomId, queueType, fromIndex, toIndex) {
    const room = ensureRoom(roomId);
    const key = queueType === "manual" ? "manualQueue" : "autoQueue";
    const queue = room[key];
    if (!queue) return;
    const [item] = queue.splice(fromIndex, 1);
    queue.splice(toIndex, 0, item);
}

function setAutoQueue(roomId, songs) {
    const room = ensureRoom(roomId);
    room.autoQueue = [...songs];
}

/**
 * Advance the queue — manual queue takes priority over auto queue.
 * Returns the next song object, or null if both queues are empty.
 */
function advance(roomId) {
    const room = ensureRoom(roomId);
    if (room.manualQueue.length > 0) {
        return room.manualQueue.shift();
    }
    if (room.autoQueue.length > 0) {
        return room.autoQueue.shift();
    }
    return null;
}

/**
 * Append more songs to the auto queue (called when it runs low).
 * Avoids adding duplicates already present in the queue.
 */
function replenishAutoQueue(roomId, songs) {
    const room = ensureRoom(roomId);
    const existingUris = new Set(room.autoQueue.map((s) => s.uri));
    for (const song of songs) {
        if (!existingUris.has(song.uri)) {
            room.autoQueue.push(song);
            existingUris.add(song.uri);
        }
    }
}

module.exports = {
    ensureRoom,
    getQueue,
    addToManualQueue,
    removeFromQueue,
    reorderQueue,
    setAutoQueue,
    advance,
    replenishAutoQueue,
};
