'use strict';

const messaging = require.main.require('./src/messaging');
const user = require.main.require('./src/user');
const db = require.main.require('./src/database');
const translator = require.main.require('./src/translator');

const plugin = {};

// Tunables
const MAX_RESULTS = 200; // hard cap on total matches returned to the client
const ROOM_CONCURRENCY = 10; // rooms scanned in parallel
const RAW_READ_CHUNK = 2500; // mids per raw-content DB read, bounds peak memory/query size

plugin.init = async (params) => {
    const socketPlugins = require.main.require('./src/socket.io/plugins');
    socketPlugins.chatSearch = {};
    socketPlugins.chatSearch.searchGlobal = searchGlobal;
};

plugin.addClientScript = async (scripts) => {
    scripts.push('plugins/nodebb-plugin-chat-search/static/lib/main.js');
    return scripts;
};

// Returns the candidate mids visible for this search (newest first),
// mirroring the visibility rules of Messaging.getMessages.
async function getCandidateMids({ callerUid, targetUid, roomId, allowFullHistory }) {
    const key = `chat:room:${roomId}:mids`;
    if (allowFullHistory) {
        // Admin viewing specific rooms: full history, no per-user filtering.
        return await db.getSortedSetRevRange(key, 0, -1);
    }
    // The standard path only ever exposes a user's own conversations.
    if (parseInt(callerUid, 10) !== parseInt(targetUid, 10)) {
        return [];
    }
    const isPublic = await db.getObjectField(`chat:room:${roomId}`, 'public');
    if (parseInt(isPublic, 10) === 1) {
        return await db.getSortedSetRevRange(key, 0, -1);
    }
    // Private rooms: only messages sent after the user joined.
    const userjoinTimestamp = await db.sortedSetScore(`chat:room:${roomId}:uids`, targetUid);
    return await db.getSortedSetRevRangeByScore(key, 0, -1, '+inf', userjoinTimestamp);
}

// Cheaply finds matching mids by scanning only the raw `content` field, avoiding
// the heavy parse/render pipeline for the (vast majority of) non-matching messages.
async function findMatchingMids({ mids, query, targetUid }) {
    if (!mids.length) {
        return [];
    }
    const matched = [];
    for (let i = 0; i < mids.length; i += RAW_READ_CHUNK) {
        const chunk = mids.slice(i, i + RAW_READ_CHUNK);
        const raw = await db.getObjectsFields(
            chunk.map(mid => `message:${mid}`),
            ['content', 'deleted', 'fromuid']
        );
        for (let j = 0; j < chunk.length; j += 1) {
            const msg = raw[j];
            if (!msg || !msg.content) {
                continue;
            }
            // Deleted messages are shown to their author only, matching
            // getMessagesData's placeholder behaviour for everyone else.
            const isOwner = parseInt(msg.fromuid, 10) === parseInt(targetUid, 10);
            if (parseInt(msg.deleted, 10) === 1 && !isOwner) {
                continue;
            }
            if (String(msg.content).toLowerCase().includes(query)) {
                matched.push(chunk[j]);
            }
        }
    }
    return matched;
}

// Attaches the room/participant/sender metadata expected by the client UI.
async function decorateRoomMatches({ matches, roomId, targetUid, userLang }) {
    const uids = await messaging.getUidsInRoom(roomId, 0, -1);
    const usersData = await user.getUsersFields(uids, ['uid', 'username', 'picture', 'icon:text', 'icon:bgColor']);
    const otherUsers = usersData.filter(u => parseInt(u.uid, 10) !== parseInt(targetUid, 10));

    let displayName = '';
    if (otherUsers.length === 0) {
        displayName = await translate(userLang, 'room.self-chat');
    } else if (otherUsers.length <= 2) {
        displayName = otherUsers.map(u => u.username).join(', ');
    } else {
        const firstTwo = otherUsers.slice(0, 2).map(u => u.username).join(', ');
        const remaining = otherUsers.length - 2;
        displayName = await translate(userLang, 'room.and-more-users', firstTwo, remaining);
    }

    const roomData = await messaging.getRoomData(roomId);
    const roomName = (roomData && roomData.roomName) || displayName;

    matches.forEach((m) => {
        if (!m.mid && m.messageId) m.mid = m.messageId;
        if (!m.roomId) m.roomId = roomId;
        if (!m.user || !m.user.username) {
            const sender = usersData.find(u => parseInt(u.uid, 10) === parseInt(m.fromuid, 10));
            m.user = sender || { username: 'Unknown', 'icon:bgColor': '#aaa' };
        }
        m.roomName = roomName;
        m.targetUid = targetUid;
        m.participants = otherUsers;
    });

    return matches;
}

// Scans a single room: find matching mids on raw content, then render only the matches.
async function searchRoom({ callerUid, targetUid, roomId, query, allowFullHistory, userLang }) {
    const mids = await getCandidateMids({ callerUid, targetUid, roomId, allowFullHistory });
    if (!mids.length) {
        return [];
    }

    const matchedMids = await findMatchingMids({ mids, query, targetUid });
    if (!matchedMids.length) {
        return [];
    }

    // The expensive render pipeline now runs only for actual matches.
    const messages = await messaging.getMessagesData(matchedMids, targetUid, roomId, false);
    if (!messages || !messages.length) {
        return [];
    }

    return await decorateRoomMatches({ matches: messages, roomId, targetUid, userLang });
}

async function searchGlobal(socket, data) {
    if (!socket.uid) throw new Error('Not logged in');
    const isAdmin = await user.isAdministrator(socket.uid);
    const settings = await user.getSettings(socket.uid);
    const userLang = settings.userLang || 'en-GB';

    let targetUid = socket.uid;
    if (data.targetUid && parseInt(data.targetUid, 10) !== parseInt(socket.uid, 10)) {
        if (!isAdmin) {
            throw new Error(await translate(userLang, 'error.no-privileges'));
        }
        targetUid = data.targetUid;
    }

    // Guard against an empty query, which would otherwise match every message.
    const query = String(data.query || '').trim().toLowerCase();
    if (!query) {
        return [];
    }

    const requestedRoomIds = Array.isArray(data.roomIds) ? data.roomIds : null;
    let roomIds = requestedRoomIds && requestedRoomIds.length
        ? [...new Set(requestedRoomIds.map(rid => parseInt(rid, 10)).filter(rid => Number.isFinite(rid) && rid > 0))]
        : await db.getSortedSetRevRange('uid:' + targetUid + ':chat:rooms', 0, -1);
    const allowFullHistory = isAdmin && requestedRoomIds && requestedRoomIds.length;

    // Non-admins may only search rooms they actually belong to.
    if (!isAdmin) {
        const inRoom = await Promise.all(roomIds.map(roomId => messaging.isUserInRoom(targetUid, roomId)));
        roomIds = roomIds.filter((roomId, idx) => inRoom[idx]);
    }

    const allResults = [];
    // Process rooms in bounded-concurrency batches, stopping once we have enough.
    for (let i = 0; i < roomIds.length && allResults.length < MAX_RESULTS; i += ROOM_CONCURRENCY) {
        const batch = roomIds.slice(i, i + ROOM_CONCURRENCY);
        const batchResults = await Promise.all(batch.map(roomId =>
            searchRoom({ callerUid: socket.uid, targetUid, roomId, query, allowFullHistory, userLang })
                .catch((err) => {
                    console.error(`[Chat Search] Error in room ${roomId}: ${err.message}`);
                    return [];
                })));
        batchResults.forEach(r => allResults.push(...r));
    }

    return allResults.slice(0, MAX_RESULTS);
}

async function translate(language, key, ...args) {
    return await translator.translate(
        translator.compile(`chat-search:${key}`, ...args),
        language
    );
}

module.exports = plugin;
