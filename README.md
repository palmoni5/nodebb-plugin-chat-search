# NodeBB Global Chat Search

Standard chat search in NodeBB works well when you already know which room the message is in. But sometimes you remember the message — not the chat.

**NodeBB Global Chat Search** solves this by adding a global search bar to the chat sidebar, allowing you to search across **all conversations you have ever participated in**.

---

## 🚀 Features

**Global Context**  
Searches across all room IDs associated with your user account.

**Performance Focused**  
Matching is done against raw message content first, so the expensive render pipeline runs only for actual hits. Rooms are scanned in parallel with bounded concurrency, and the number of matches kept per room is capped, so a very common word cannot make a single busy room dominate the whole request.

**Stable, Chronological Results**  
Every room the user can see is scanned on every search, and all matches are then ranked globally by timestamp before the result list is cut. The result set therefore does not shift around as rooms move up and down the recent-chats list.

**Sticky UI**  
Your search query and results remain visible when navigating between chat rooms.

**Smart Navigation**  
Clicking a search result scrolls directly to the message and highlights it with a smooth transition.

**Rich Previews**  
Results include room names, sender avatars, and timestamps, matching the native NodeBB interface.

**English + Hebrew Friendly**
Server-generated labels now adapt correctly for English and Hebrew users instead of relying on hard-coded Hebrew text.

---

## 🛠 Technical Details

**Hooks Used**

- `static:app.load` — server initialization  
- `filter:scripts.client` — injecting the search interface into the chat UI

**DOM Management**

Uses a `MutationObserver` to ensure the search bar is injected correctly regardless of how the chat page loads.

**State Management**

Implements `window.chatSearchState` so search results persist during Ajaxify navigation.

**Error Handling**

Rooms that fail to scan are reported to the client instead of being silently treated as empty, and the client applies its own timeout so a lost socket acknowledgement surfaces as an error rather than an endless spinner.

**Limits**

The search performs a linear scan rather than using an index. To keep that bounded it scans at most the newest 20,000 messages per room, keeps at most 200 matches per room, and returns at most 200 results overall; the UI says so when a result set was cut. Note that this scan reads every message object through NodeBB's shared object cache (40,000 entries), so on very large forums frequent searches will evict other cached data.

**Compatibility**

Built for NodeBB **^3.0.0 || ^4.0.0**

---

## 📥 Installation

Install the plugin via terminal:

```bash
npm install nodebb-plugin-chat-search
```
Then:

1. Activate the plugin in the **Admin Control Panel (ACP)**
2. **Rebuild** your NodeBB instance
3. **Restart** the forum

---

## 🔗 Links

**GitHub**  
https://github.com/palmoni5/nodebb-plugin-chat-search

**Issues**  
Report bugs or request features via the repository issue tracker.

---

## 💬 Feedback

Feedback, suggestions, and feature requests are welcome.  
If this plugin helps you, consider starring the repository ⭐
