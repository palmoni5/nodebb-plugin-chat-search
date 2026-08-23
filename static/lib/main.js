'use strict';

window.chatSearchState = window.chatSearchState || {
    query: '',
    resultsHtml: '',
    isOpen: false,
    lastScroll: 0
};

$(document).ready(function () {
    const isHebrew = (document.documentElement.lang || 'en').startsWith('he');
    
    const txt = {
        placeholder: isHebrew ? 'חפש הודעה...' : 'Search messages...',
        searching: isHebrew ? 'מחפש...' : 'Searching...',
        error: isHebrew ? 'שגיאה' : 'Error',
        noResults: isHebrew ? 'לא נמצאו תוצאות.' : 'No results found.',
        unknownUser: isHebrew ? 'לא ידוע' : 'Unknown',
        timeout: isHebrew ? 'החיפוש נמשך זמן רב מדי. נסה מונח ארוך או מדויק יותר.' : 'The search took too long. Try a longer or more specific term.',
        tooShort: isHebrew ? 'הקלד לפחות 2 תווים.' : 'Type at least 2 characters.',
        truncated: isHebrew ? 'לא כל ההתאמות מוצגות. צמצם את החיפוש כדי לראות את כולן.' : 'Not all matches are shown. Narrow the search to see them all.',
        incomplete: isHebrew ? 'חלק מהחדרים לא נסרקו בגלל שגיאה. התוצאות חלקיות.' : 'Some rooms could not be searched. These results are partial.'
    };

    let observer = null;
    let debounceTimer = null;
    let searchSeq = 0;
    const SEARCH_DEBOUNCE_MS = 350;
    // The server has no ack timeout of its own, and a socket that reconnects mid-flight
    // never fires its callback at all - without this the spinner would spin forever.
    const SEARCH_TIMEOUT_MS = 45000;
    const MIN_QUERY_LENGTH = 2;

    $(window).on('action:ajaxify.end', function (ev, data) {
        if (observer) observer.disconnect();
        const isChatUrl = data.url.match(/^(user\/[^\/]+\/)?chats/);
        const isChatTemplate = data.template && (data.template.name === 'chats' || data.template === 'chats');

        if (isChatUrl || isChatTemplate) {
            initSearchInjection();
        } else {
            window.chatSearchState = { query: '', resultsHtml: '', isOpen: false, lastScroll: 0 };
        }
    });

    $(window).on('action:chat.loaded', function (ev, data) {
        highlightActiveChat();
    });

    if (ajaxify.data.template && (ajaxify.data.template.name === 'chats' || ajaxify.data.template === 'chats')) {
        initSearchInjection();
    }

    function initSearchInjection() {
        if (!injectSearchBar()) {
            const targetNode = document.body;
            const config = { childList: true, subtree: true };
            observer = new MutationObserver(function(mutationsList) {
                const container = findContainer();
                if (container.length > 0) {
                    injectSearchBar(container);
                    observer.disconnect(); 
                }
            });
            observer.observe(targetNode, config);
        }
    }

    function findContainer() {
        let container = $('[component="chat/nav-wrapper"]'); 
        if (container.length === 0) container = $('.chats-page').find('.col-md-4').first();
        if (container.length === 0) container = $('[component="chat/list"]').parent();
        return container;
    }

    function injectSearchBar(containerElement) {
        const container = containerElement || findContainer();
        if (container.length === 0) return false;
        if ($('#global-chat-search-container').length > 0) return true;

        const searchHtml = `
            <div id="global-chat-search-container" style="padding: 10px; background: #fff; border-bottom: 1px solid #ddd; margin-bottom: 5px;">
                <div class="input-group">
                    <input type="text" id="global-chat-search" class="form-control" placeholder="${txt.placeholder}" style="font-size: 14px; height: 34px;">
                    <span class="input-group-btn">
                        <button class="btn btn-primary" id="btn-chat-search" type="button" style="height: 34px;"><i class="fa fa-search"></i></button>
                    </span>
                </div>
                <div id="global-search-results" class="chats-list overflow-auto ghost-scrollbar" style="margin-top: 5px; max-height: 400px; display:none;"></div>
            </div>
        `;

        container.prepend(searchHtml);
        restoreState();
        attachEvents();
        return true;
    }

    function attachEvents() {
        $('#btn-chat-search').off('click').on('click', function () {
            clearTimeout(debounceTimer);
            executeSearch();
        });
        const input = $('#global-chat-search');
        input.off('keypress').on('keypress', function (e) {
            if (e.which === 13) {
                clearTimeout(debounceTimer);
                executeSearch();
            }
        });
        input.off('input').on('input', function() {
            window.chatSearchState.query = $(this).val();
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(executeSearch, SEARCH_DEBOUNCE_MS);
        });
        $('#global-search-results').off('scroll').on('scroll', function() {
            window.chatSearchState.lastScroll = $(this).scrollTop();
        });
    }

    function restoreState() {
        const input = $('#global-chat-search');
        const results = $('#global-search-results');
        if (window.chatSearchState.query) input.val(window.chatSearchState.query);
        if (window.chatSearchState.isOpen && window.chatSearchState.resultsHtml) {
            results.html(window.chatSearchState.resultsHtml).show();
            if ($.fn.timeago) results.find('.timeago').timeago();
            if (window.chatSearchState.lastScroll > 0) results.scrollTop(window.chatSearchState.lastScroll);
            highlightActiveChat();
        }
    }

    // Escapes values before HTML injection. Since NodeBB 4.13 (Benchpress default
    // escaping), core no longer escapes on read — roomName, username and picture
    // arrive raw from Messaging.getRoomData / User.getUsersFields and MUST be
    // escaped here. Message content stays as-is (parsed HTML, reduced by cleanContent).
    function escapeHtml(str) {
        return String(str === null || str === undefined ? '' : str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function buildAvatarHtml(user, sizePx, extraStyle = '', extraClasses = '') {
        const sizeVal = sizePx + 'px';
        const bgStyle = `background-color: ${escapeHtml(user['icon:bgColor'] || '#5c5c5c')};`;
        const commonStyle = `style="--avatar-size: ${sizeVal}; width: ${sizeVal}; height: ${sizeVal}; line-height: ${sizeVal}; ${bgStyle} ${extraStyle}"`;
        const classes = `avatar avatar-rounded ${extraClasses}`;

        const safeUsername = escapeHtml(user.username);
        if (user.picture) {
            return `<span title="${safeUsername}" class="${classes}" component="avatar/picture" ${commonStyle}><img src="${escapeHtml(user.picture)}" alt="${safeUsername}" class="avatar avatar-rounded"></span>`;
        }

        const text = escapeHtml(user['icon:text'] || (user.username ? user.username[0].toUpperCase() : '?'));
        return `<span title="${safeUsername}" class="${classes}" component="avatar/icon" ${commonStyle}>${text}</span>`;
    }

    function renderMainAvatars(participants) {
        if (!participants || participants.length === 0) {
             return `<div class="main-avatar">
                        <span class="avatar avatar-rounded" style="--avatar-size: 32px; width:32px; height:32px; background-color: #ccc">?</span>
                    </div>`;
        }

        return `<div class="main-avatar">
                    ${buildAvatarHtml(participants[0], 32)}
                </div>`;
    }

    function cleanContent(content) {
        if (!content) return '';
        // The teaser is rendered inside the <a> that makes the whole row clickable.
        // Message content is parsed HTML that may contain nested <a> (links, mentions,
        // attachments) and block elements (<hr>, <h2>, <ol>, <code>…) — all illegal
        // inside an anchor, so the browser's adoption-agency parsing splits the row into
        // fragments. Reduce it to a plain-text preview (as NodeBB core's chat teasers do).
        // DOMParser neither runs scripts nor loads resources. The result is escaped because
        // it's injected as raw HTML downstream and entity decoding can reintroduce markup.
        let text;
        try {
            const doc = new DOMParser().parseFromString(content, 'text/html');
            text = (doc.body && doc.body.textContent) || '';
        } catch (e) {
            text = content.replace(/<[^>]*>/g, ' ');
        }
        return escapeHtml(text.replace(/\s+/g, ' ').trim());
    }

    function isAdminAllChatsPage() {
        return !!(ajaxify && ajaxify.data && ajaxify.data.adminAllChats);
    }

    function getDisplayedRoomIds() {
        const ids = [];
        const seen = {};

        function addRoomId(roomId) {
            const rid = parseInt(roomId, 10);
            if (rid && !seen[rid]) {
                ids.push(rid);
                seen[rid] = true;
            }
        }

        // Prefer server payload when available (admin-chats all-chats page)
        if (ajaxify && ajaxify.data) {
            if (Array.isArray(ajaxify.data.rooms)) {
                ajaxify.data.rooms.forEach(r => addRoomId(r && (r.roomId || r.roomid)));
            }
            if (Array.isArray(ajaxify.data.publicRooms)) {
                ajaxify.data.publicRooms.forEach(r => addRoomId(r && (r.roomId || r.roomid)));
            }
        }

        // Also scan DOM (covers infinite scroll appended rooms)
        const $recent = $("[component=\"chat/recent\"]");
        const $scope = $recent.length ? $recent : $("#content");

        $scope.find("[data-roomid], [data-room-id], [data-roomId]").each(function () {
            addRoomId($(this).attr("data-roomid") || $(this).attr("data-room-id") || $(this).attr("data-roomId"));
        });

        // Fallback: parse chat links (e.g. /chats/123 or chats/123)
        $scope.find("a[href]").each(function () {
            const href = $(this).attr("href") || "";
            const m = href.match(/(?:^|\/)(?:user\/[^\/]+\/)?chats\/(\d+)/);
            if (m && m[1]) addRoomId(m[1]);
        });

        return ids;
    }

    function showMessage(container, html) {
        container.html(html);
        window.chatSearchState.resultsHtml = html;
        window.chatSearchState.lastScroll = 0;
    }

    function executeSearch() {
        const query = $('#global-chat-search').val();
        const resultsContainer = $('#global-search-results');

        if (!query) {
            resultsContainer.hide();
            window.chatSearchState.isOpen = false;
            window.chatSearchState.resultsHtml = '';
            return;
        }

        window.chatSearchState.query = query;
        window.chatSearchState.isOpen = true;
        resultsContainer.show();

        if (query.trim().length < MIN_QUERY_LENGTH) {
            // Mirrors the server-side guard, so a one-character query never triggers a
            // full scan of every room.
            showMessage(resultsContainer, `<div class="text-center" style="padding:10px; color:#777;">${txt.tooShort}</div>`);
            return;
        }

        resultsContainer.html(`<div class="text-center" style="padding:10px;"><i class="fa fa-spinner fa-spin"></i> ${txt.searching}</div>`);

        // Always search on behalf of the logged-in user. ajaxify.data.uid is the uid of
        // the profile being viewed, which is not necessarily the viewer - sending that
        // makes the server reject the request, or return nothing at all.
        const payload = { query: query, targetUid: app.user.uid };
        if (isAdminAllChatsPage()) {
            const roomIds = getDisplayedRoomIds();
            if (roomIds.length) payload.roomIds = roomIds;
        }

        // Ignore responses from searches that have since been superseded by a newer one.
        const seq = ++searchSeq;
        let settled = false;

        const timer = setTimeout(function () {
            if (settled || seq !== searchSeq) return;
            settled = true;
            showMessage(resultsContainer, `<div class="alert alert-warning" style="margin:5px;">${txt.timeout}</div>`);
        }, SEARCH_TIMEOUT_MS);

        socket.emit('plugins.chatSearch.searchGlobal', payload, function (err, response) {
            clearTimeout(timer);
            if (settled || seq !== searchSeq) return;
            settled = true;

            if (err) {
                // Clear the stored html too, otherwise restoreState() would later put the
                // previous query's results back on screen under the current query.
                showMessage(resultsContainer, `<div class="alert alert-danger" style="margin:5px;">${txt.error}</div>`);
                return;
            }

            // Back-compat: older server versions returned a bare array of messages.
            const data = Array.isArray(response) ? { messages: response } : (response || {});
            const messages = data.messages || [];

            if (!messages.length) {
                showMessage(resultsContainer, `<div class="text-center" style="padding:10px; color:#777;">${txt.noResults}</div>`);
                return;
            }

            let html = '<div class="d-flex flex-column">';
            if (data.incomplete) {
                html += `<div class="alert alert-warning text-xs" style="margin:5px;">${txt.incomplete}</div>`;
            }
            messages.forEach(msg => {
                // Coerce server-supplied ids/timestamps to safe primitives before they
                // reach href/onclick/attribute sinks; guard against an invalid timestamp
                // which would otherwise throw and abort the whole render.
                const ts = parseInt(msg.timestamp, 10);
                let isoTime = '';
                if (ts) {
                    try { isoTime = new Date(ts).toISOString(); } catch (e) { isoTime = ''; }
                }

                const mid = parseInt(msg.mid, 10);
                const roomId = parseInt(msg.roomId, 10);
                const chatLink = (config.relative_path || '') + '/message/' + mid;
                const senderName = escapeHtml((msg.user && msg.user.username) ? msg.user.username : txt.unknownUser);

                const mainAvatarHtml = renderMainAvatars(msg.participants);
                const senderSmallAvatar = buildAvatarHtml(msg.user, 14, 'vertical-align: text-bottom;', 'align-middle');

                const cleanedContent = cleanContent(msg.content);

                html += `
                    <div component="chat/recent/room" class="rounded-1 search-result" data-roomid="${roomId}">
                        <div class="d-flex gap-1 justify-content-between">
                            <a href="${chatLink}" onclick="ajaxify.go('${chatLink}'); return false;" class="chat-room-btn position-relative d-flex flex-grow-1 gap-2 justify-content-start align-items-start btn btn-ghost btn-sm ff-sans text-start" style="padding: 0.5rem;">
                                
                                ${mainAvatarHtml}
                                
                                <div class="d-flex flex-grow-1 flex-column w-100" style="min-width:0;">
                                    <div component="chat/room/title" class="room-name fw-semibold text-xs text-break">
                                        ${escapeHtml(msg.roomName)}
                                    </div>
                                    <div component="chat/room/teaser">
                                        
                                        <div class="teaser-content text-sm line-clamp-3 text-break mb-0">
                                            ${senderSmallAvatar}
                                            <strong class="text-xs fw-semibold teaser-username">${senderName}:</strong> 
                                            ${cleanedContent}
                                        </div>
                                        
                                        <div class="teaser-timestamp text-muted text-xs" style="margin-top: 2px; line-height: 1;">
                                            <span class="timeago" title="${isoTime}"></span>
                                        </div>

                                    </div>
                                </div>
                            </a>
                        </div>
                    </div>
                    <hr class="my-1">
                `;
            });
            if (data.truncated) {
                html += `<div class="text-center text-muted text-xs" style="padding:6px;">${txt.truncated}</div>`;
            }
            html += '</div>';

            showMessage(resultsContainer, html);

            if ($.fn.timeago) {
                resultsContainer.find('.timeago').timeago();
            }

            highlightActiveChat();
        });
    }

    function highlightActiveChat() {
        let currentRoomId = ajaxify.data.roomId;
        if (!currentRoomId) {
             const match = window.location.pathname.match(/chats\/(\d+)/);
             if (match) currentRoomId = match[1];
        }
        if (!currentRoomId) return;
        $('.search-result').removeClass('active');
        const activeItem = $('.search-result[data-roomid="' + currentRoomId + '"]');
        activeItem.addClass('active');
    }

});
