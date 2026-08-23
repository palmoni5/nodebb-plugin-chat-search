'use strict';

const winston = require.main.require('winston');
const messaging = require.main.require('./src/messaging');
const user = require.main.require('./src/user');
const db = require.main.require('./src/database');
const translator = require.main.require('./src/translator');

const plugin = {};

// Tunables
const MAX_RESULTS = 200; // hard cap on total matches returned to the client
const MAX_MATCHES_PER_ROOM = 200; // hard cap on matches kept per room, before rendering
const MAX_SCANNED_MIDS_PER_ROOM = 20000; // newest N messages scanned per room
const ROOM_CONCURRENCY = 10; // rooms scanned in parallel
const RAW_READ_CHUNK = 500; // mids per raw-content DB read, bounds peak memory and event-loop blocking
const MIN_QUERY_LENGTH = 2; // shorter queries match nearly everything and are not worth a full scan

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
        return await db.getSortedSetRevRange(key, 0, MAX_SCANNED_MIDS_PER_ROOM - 1);
    }
    // The standard path only ever exposes a user's own conversations.
    if (parseInt(callerUid, 10) !== parseInt(targetUid, 10)) {
        return [];
    }
    const roomData = await messaging.getRoomData(roomId, ['public']);
    if (roomData && roomData.public) {
        return await db.getSortedSetRevRange(key, 0, MAX_SCANNED_MIDS_PER_ROOM - 1);
    }
    // Private rooms: only messages sent after the user joined. sortedSetScore returns
    // null when the membership set and the user's room list have drifted apart (core
    // self-heals this in modifyChatRooms); passing that null through would make the
    // range query throw on redis and match nothing on mongo, silently emptying the room.
    const userjoinTimestamp = await db.sortedSetScore(`chat:room:${roomId}:uids`, targetUid);
    return await db.getSortedSetRevRangeByScore(
        key, 0, MAX_SCANNED_MIDS_PER_ROOM, '+inf', userjoinTimestamp || 0
    );
}

// Cheaply finds matching messages by scanning only the raw `content` field, avoiding
// the heavy parse/render pipeline for the (vast majority of) non-matching messages.
// Returns { matches: [{ mid, timestamp }], truncated } with matches newest-first.
async function findMatches({ mids, query, targetUid }) {
    const matches = [];
    for (let i = 0; i < mids.length; i += RAW_READ_CHUNK) {
        const chunk = mids.slice(i, i + RAW_READ_CHUNK);
        // eslint-disable-next-line no-await-in-loop
        const raw = await db.getObjectsFields(
            chunk.map(mid => `message:${mid}`),
            ['content', 'deleted', 'fromuid', 'timestamp']
        );
        for (let j = 0; j < chunk.length; j += 1) {
            const msg = raw[j];
            if (msg && msg.content) {
                // Deleted messages are shown to their author only, matching
                // getMessagesData's placeholder behaviour for everyone else.
                const isOwner = parseInt(msg.fromuid, 10) === parseInt(targetUid, 10);
                const isHidden = parseInt(msg.deleted, 10) === 1 && !isOwner;
                if (!isHidden && String(msg.content).toLowerCase().includes(query)) {
                    matches.push({
                        mid: chunk[j],
                        timestamp: parseInt(msg.timestamp, 10) || 0,
                    });
                    // Without this cap a common word ("the", "של") matches tens of
                    // thousands of messages in a single room, and every one of them
                    // would go through Messaging.parse below.
                    if (matches.length >= MAX_MATCHES_PER_ROOM) {
                        return { matches, truncated: true };
                    }
                }
            }
        }
    }
    return { matches, truncated: false };
}

// Attaches the room/participant/sender metadata expected by the client UI.
async function decorateRoomMatches({ matches, roomId, targetUid, userLang }) {
    // Bounded: a large public room can hold thousands of uids, and the UI only ever
    // renders one avatar plus a couple of names.
    const uids = await messaging.getUidsInRoom(roomId, 0, 49);
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
        // Prefer the sender core already resolved: a user who has since left the room
        // is not in usersData and would otherwise be rendered as "Unknown".
        if (!m.user || !m.user.username) {
            m.user = m.fromUser ||
                usersData.find(u => parseInt(u.uid, 10) === parseInt(m.fromuid, 10)) ||
                { username: 'Unknown', 'icon:bgColor': '#aaa' };
        }
        m.roomName = roomName;
        m.targetUid = targetUid;
        m.participants = otherUsers;
    });

    return matches;
}

// Scans a single room on raw content only. Rendering happens later, and only for the
// matches that survive the global cut, so a busy room cannot dominate the work.
async function scanRoom({ callerUid, targetUid, roomId, query, allowFullHistory }) {
    const mids = await getCandidateMids({ callerUid, targetUid, roomId, allowFullHistory });
    if (!mids.length) {
        return { roomId, matches: [], truncated: false };
    }
    const { matches, truncated } = await findMatches({ mids, query, targetUid });
    return {
        roomId,
        matches: matches.map(m => ({ ...m, roomId })),
        truncated: truncated || mids.length >= MAX_SCANNED_MIDS_PER_ROOM,
    };
}

// Runs the expensive render pipeline for the selected mids of a single room.
async function renderRoomMatches({ roomId, mids, targetUid, userLang }) {
    const messages = await messaging.getMessagesData(mids, targetUid, roomId, false);
    if (!messages || !messages.length) {
        return [];
    }
    return await decorateRoomMatches({ matches: messages, roomId, targetUid, userLang });
}

// Applies `worker` to `items` in bounded-concurrency batches, keeping per-item
// failures visible instead of silently turning them into empty results.
async function mapWithConcurrency(items, worker) {
    const results = [];
    const errors = [];
    for (let i = 0; i < items.length; i += ROOM_CONCURRENCY) {
        const batch = items.slice(i, i + ROOM_CONCURRENCY);
        // eslint-disable-next-line no-await-in-loop
        const settled = await Promise.allSettled(batch.map(item => worker(item)));
        settled.forEach((outcome, idx) => {
            if (outcome.status === 'fulfilled') {
                results.push(outcome.value);
            } else {
                errors.push(outcome.reason);
                winston.warn(`[chat-search] room ${batch[idx].roomId || batch[idx]} failed: ${outcome.reason && outcome.reason.message}`);
            }
        });
    }
    return { results, errors };
}

// Newest first. mids can be non-numeric (federated messages carry URIs), so the
// tiebreaker falls back to a string comparison rather than producing NaN.
function compareByRecency(a, b) {
    const byTime = (parseInt(b.timestamp, 10) || 0) - (parseInt(a.timestamp, 10) || 0);
    if (byTime) {
        return byTime;
    }
    return String(b.mid).localeCompare(String(a.mid), undefined, { numeric: true });
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

    // Guard against an empty or one-character query, which would otherwise scan every
    // message in every room only to match nearly all of them.
    const query = String(data.query || '').trim().toLowerCase();
    if (query.length < MIN_QUERY_LENGTH) {
        return { messages: [], truncated: false, incomplete: false };
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
    if (!roomIds.length) {
        return { messages: [], truncated: false, incomplete: false };
    }

    // Phase 1 - scan every room on raw content. Every room is always scanned, so the
    // result set does not depend on the (constantly changing) recency order of rooms.
    const scan = await mapWithConcurrency(roomIds, roomId =>
        scanRoom({ callerUid: socket.uid, targetUid, roomId, query, allowFullHistory }));

    if (scan.errors.length && !scan.results.length) {
        throw scan.errors[0];
    }

    // Phase 2 - rank all matches globally, newest first, then keep only the top slice.
    const allMatches = [];
    let truncated = false;
    scan.results.forEach((room) => {
        if (room.truncated) {
            truncated = true;
        }
        allMatches.push(...room.matches);
    });
    allMatches.sort(compareByRecency);
    if (allMatches.length > MAX_RESULTS) {
        truncated = true;
    }
    const selected = allMatches.slice(0, MAX_RESULTS);

    // Phase 3 - render only what is actually going to be shown, grouped per room.
    const byRoom = new Map();
    selected.forEach((m) => {
        const list = byRoom.get(m.roomId) || [];
        list.push(m.mid);
        byRoom.set(m.roomId, list);
    });
    const render = await mapWithConcurrency(
        [...byRoom.entries()].map(([roomId, mids]) => ({ roomId, mids })),
        ({ roomId, mids }) => renderRoomMatches({ roomId, mids, targetUid, userLang })
    );

    if (render.errors.length && !render.results.length) {
        throw render.errors[0];
    }

    const messages = [].concat(...render.results);
    messages.sort(compareByRecency);

    return {
        messages,
        truncated,
        incomplete: scan.errors.length > 0 || render.errors.length > 0,
    };
}

async function translate(language, key, ...args) {
    return await translator.translate(
        translator.compile(`chat-search:${key}`, ...args),
        language
    );
}

module.exports = plugin;
