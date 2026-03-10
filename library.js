'use strict';

const messaging = require.main.require('./src/messaging');
const user = require.main.require('./src/user');
const db = require.main.require('./src/database');

const plugin = {};

plugin.init = async (params) => {
    const socketPlugins = require.main.require('./src/socket.io/plugins');
    socketPlugins.chatSearch = {};
    socketPlugins.chatSearch.searchGlobal = searchGlobal;
};

plugin.addClientScript = async (scripts) => {
    scripts.push('plugins/nodebb-plugin-chat-search/static/lib/main.js');
    return scripts;
};

async function getMessagesForSearch(params) {
    const { callerUid, targetUid, roomId, start, stop, allowFullHistory } = params;
    if (allowFullHistory) {
        const mids = await db.getSortedSetRevRange(`chat:room:${roomId}:mids`, start, stop);
        if (!mids || !mids.length) return [];
        mids.reverse();
        const messages = await messaging.getMessagesData(mids, targetUid, roomId, false);
        messages.forEach((msg) => {
            if (!msg.mid && msg.messageId) msg.mid = msg.messageId;
        });
        return messages;
    }
    const messages = await messaging.getMessages({
        callerUid: callerUid,
        uid: targetUid,
        roomId: roomId,
        isNew: false,
        start: start,
        stop: stop,
    });
    return messages || [];
}

async function searchGlobal(socket, data) {
    if (!socket.uid) throw new Error('Not logged in');
    const isAdmin = await user.isAdministrator(socket.uid);
    
    let targetUid = socket.uid;
    if (data.targetUid && parseInt(data.targetUid, 10) !== parseInt(socket.uid, 10)) {
        if (!isAdmin) throw new Error('אין הרשאה.');
        targetUid = data.targetUid;
    }

    const query = data.query;
    const requestedRoomIds = Array.isArray(data.roomIds) ? data.roomIds : null;
    const roomIds = requestedRoomIds && requestedRoomIds.length
        ? [...new Set(requestedRoomIds.map(rid => parseInt(rid, 10)).filter(rid => Number.isFinite(rid) && rid > 0))]
        : await db.getSortedSetRevRange('uid:' + targetUid + ':chat:rooms', 0, -1);
    let allResults = [];
    const allowFullHistory = isAdmin && requestedRoomIds && requestedRoomIds.length;

    for (const roomId of roomIds) {
        if (!isAdmin) {
            const inRoom = await messaging.isUserInRoom(targetUid, roomId);
            if (!inRoom) continue;
        }

        try {
            let start = 0;
            const batchSize = 50;
            let roomMatches = [];
            let continueFetching = true;

            while (continueFetching) {
                const messages = await getMessagesForSearch({
                    callerUid: socket.uid,
                    targetUid: targetUid,
                    roomId: roomId,
                    start: start,
                    stop: start + batchSize - 1,
                    allowFullHistory: allowFullHistory,
                });

                if (!messages || !Array.isArray(messages) || messages.length === 0) {
                    continueFetching = false;
                    break;
                }

                const matches = messages.filter(msg => 
                    msg.content && msg.content.toLowerCase().includes(query.toLowerCase())
                );
                
                if (matches.length > 0) {
                    roomMatches = roomMatches.concat(matches);
                }

                if (messages.length < batchSize) {
                    continueFetching = false;
                } else {
                    start += batchSize;
                }
            }

            if (roomMatches.length > 0) {
                const uids = await messaging.getUidsInRoom(roomId, 0, -1);
                const usersData = await user.getUsersFields(uids, ['uid', 'username', 'picture', 'icon:text', 'icon:bgColor']);
                const otherUsers = usersData.filter(u => parseInt(u.uid, 10) !== parseInt(targetUid, 10));

                let displayName = '';
                if (otherUsers.length === 0) displayName = 'צ\'אט עצמי';
                else if (otherUsers.length <= 2) displayName = otherUsers.map(u => u.username).join(', ');
                else {
                    const firstTwo = otherUsers.slice(0, 2).map(u => u.username).join(', ');
                    const remaining = otherUsers.length - 2;
                    displayName = `${firstTwo} ועוד ${remaining} משתמשים`;
                }

                const roomData = await messaging.getRoomData(roomId);
                let roomName = (roomData && roomData.roomName) || displayName;

                roomMatches.forEach(m => {
                    if (!m.roomId) m.roomId = roomId;
                    if (!m.user || !m.user.username) {
                        const sender = usersData.find(u => parseInt(u.uid, 10) === parseInt(m.fromuid, 10));
                        m.user = sender || { username: 'Unknown', 'icon:bgColor': '#aaa' };
                    }
                    m.roomName = roomName;
                    m.targetUid = targetUid;
                    m.participants = otherUsers;
                });
                
                allResults = allResults.concat(roomMatches);
            }
        } catch (err) { 
            console.error(`[Chat Search] Error in room ${roomId}: ${err.message}`); 
        }
    }
    return allResults;
}

module.exports = plugin;
