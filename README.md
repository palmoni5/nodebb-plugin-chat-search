# NodeBB Global Chat Search

Standard chat search in NodeBB works well when you already know which room the message is in. But sometimes you remember the message — not the chat.

**NodeBB Global Chat Search** solves this by adding a global search bar to the chat sidebar, allowing you to search across **all conversations you have ever participated in**.

---

## 🚀 Features

**Global Context**  
Searches across all room IDs associated with your user account.

**Performance Focused**  
Messages are fetched in batches of 50 to keep the server responsive even during deep searches.

**Sticky UI**  
Your search query and results remain visible when navigating between chat rooms.

**Smart Navigation**  
Clicking a search result scrolls directly to the message and highlights it with a smooth transition.

**Rich Previews**  
Results include room names, sender avatars, and timestamps, matching the native NodeBB interface.

---

## 🛠 Technical Details

**Hooks Used**

- `static:app.load` — server initialization  
- `filter:scripts.client` — injecting the search interface into the chat UI

**DOM Management**

Uses a `MutationObserver` to ensure the search bar is injected correctly regardless of how the chat page loads.

**State Management**

Implements `window.chatSearchState` so search results persist during Ajaxify navigation.

**Compatibility**

Built for NodeBB **^3.0.0**

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