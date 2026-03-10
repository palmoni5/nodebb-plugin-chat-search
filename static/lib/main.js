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
        unknownUser: isHebrew ? 'לא ידוע' : 'Unknown'
    };

    let observer = null;

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
        handleScrollToMessage();
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
        $('#btn-chat-search').off('click').on('click', executeSearch);
        const input = $('#global-chat-search');
        input.off('keypress').on('keypress', function (e) {
            if (e.which === 13) executeSearch();
        });
        input.on('input', function() {
            window.chatSearchState.query = $(this).val();
        });
        $('#global-search-results').on('scroll', function() {
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

    function buildAvatarHtml(user, sizePx, extraStyle = '', extraClasses = '') {
        const sizeVal = sizePx + 'px';
        const bgStyle = `background-color: ${user['icon:bgColor'] || '#5c5c5c'};`;
        const commonStyle = `style="--avatar-size: ${sizeVal}; width: ${sizeVal}; height: ${sizeVal}; line-height: ${sizeVal}; ${bgStyle} ${extraStyle}"`;
        const classes = `avatar avatar-rounded ${extraClasses}`;

        if (user.picture) {
            return `<span title="${user.username}" class="${classes}" component="avatar/picture" ${commonStyle}><img src="${user.picture}" alt="${user.username}" class="avatar avatar-rounded"></span>`;
        }
        
        const text = user['icon:text'] || (user.username ? user.username[0].toUpperCase() : '?');
        return `<span title="${user.username}" class="${classes}" component="avatar/icon" ${commonStyle}>${text}</span>`;
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
        return content.replace(/<\/?p[^>]*>/g, ' ').trim();
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

    function executeSearch() {
        const query = $('#global-chat-search').val();
        const resultsContainer = $('#global-search-results');

        if (!query) {
            resultsContainer.hide();
            window.chatSearchState.isOpen = false;
            window.chatSearchState.resultsHtml = '';
            return;
        }

        let targetUid = ajaxify.data.uid || app.user.uid;
        
        resultsContainer.show().html(`<div class="text-center" style="padding:10px;"><i class="fa fa-spinner fa-spin"></i> ${txt.searching}</div>`);
        window.chatSearchState.isOpen = true;

        const payload = { query: query, targetUid: targetUid };
        if (isAdminAllChatsPage()) {
            const roomIds = getDisplayedRoomIds();
            if (roomIds.length) payload.roomIds = roomIds;
        }

        socket.emit('plugins.chatSearch.searchGlobal', payload, function (err, messages) {
            if (err) {
                resultsContainer.html(`<div class="alert alert-danger" style="margin:5px;">${txt.error}</div>`);
                return;
            }
            if (!messages || messages.length === 0) {
                const noRes = `<div class="text-center" style="padding:10px; color:#777;">${txt.noResults}</div>`;
                resultsContainer.html(noRes);
                window.chatSearchState.resultsHtml = noRes;
                return;
            }

            let html = '<div class="d-flex flex-column">';
            messages.forEach(msg => {
                const isoTime = new Date(msg.timestamp).toISOString();
                
                let baseUrl = window.location.pathname.replace(/\/chats\/.*$/, '/chats');
                if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);
                
                const chatLink = baseUrl + '/' + msg.roomId + '?mid=' + msg.mid;
                const senderName = (msg.user && msg.user.username) ? msg.user.username : txt.unknownUser;
                
                const mainAvatarHtml = renderMainAvatars(msg.participants);
                const senderSmallAvatar = buildAvatarHtml(msg.user, 14, 'vertical-align: text-bottom;', 'align-middle');
                
                const cleanedContent = cleanContent(msg.content);

                html += `
                    <div component="chat/recent/room" class="rounded-1 search-result" data-roomid="${msg.roomId}">
                        <div class="d-flex gap-1 justify-content-between">
                            <a href="#" onclick="ajaxify.go('${chatLink}'); return false;" class="chat-room-btn position-relative d-flex flex-grow-1 gap-2 justify-content-start align-items-start btn btn-ghost btn-sm ff-sans text-start" style="padding: 0.5rem;">
                                
                                ${mainAvatarHtml}
                                
                                <div class="d-flex flex-grow-1 flex-column w-100" style="min-width:0;">
                                    <div component="chat/room/title" class="room-name fw-semibold text-xs text-break">
                                        ${msg.roomName}
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
            html += '</div>';
            
            resultsContainer.html(html);
            
            if ($.fn.timeago) {
                resultsContainer.find('.timeago').timeago();
            }

            window.chatSearchState.resultsHtml = html;
            window.chatSearchState.lastScroll = 0;
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

    function handleScrollToMessage() {
        const params = new URLSearchParams(window.location.search);
        const mid = params.get('mid');
        if (!mid) return;
        scrollToId(mid);
        let attempts = 0;
        const scrollInt = setInterval(() => {
            attempts++;
            if (scrollToId(mid) || attempts > 15) clearInterval(scrollInt);
        }, 300);
    }

    function scrollToId(mid) {
        const el = $('[data-mid="' + mid + '"]');
        if (el.length > 0) {
            el[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.css('background', '#fffeca').css('transition', 'background 1s');
            setTimeout(() => el.css('background', ''), 2000);
            return true;
        }
        return false;
    }
});
