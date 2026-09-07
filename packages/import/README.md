# X Bookmark Export v2

Capture package for X bookmark export v2. Browser scripts live in `capture/`; `parseExportV2()` turns the downloaded JSON into normalized users + tweets.

## Files

| File | Use |
|------|-----|
| [capture/capture.js](capture/capture.js) | Paste into DevTools console |
| [capture/bookmarklet.min.js](capture/bookmarklet.min.js) | Compact IIFE (same behavior) |
| [capture/bookmarklet.txt](capture/bookmarklet.txt) | `javascript:` URL for the bookmark bar |
| [schema.md](schema.md) | Export format |
| [src/parse.ts](src/parse.ts) | Server-side `parseExportV2()` |

## Console (recommended)

1. Open [https://x.com/i/bookmarks](https://x.com/i/bookmarks) while logged in (or `x.com/YourUsername/likes`).
2. DevTools → Console (`⌘⌥J` on Mac, `F12` on Windows).
3. Paste the contents of `capture.js` and press Enter.
4. Two buttons appear top-right: purple **Export** and **▶ Auto-scroll**.
5. Click Auto-scroll (or scroll yourself) until the counter stops growing.
6. Click **Export N bookmarks →**. `bookmarks.json` (or `likes.json`) downloads.

Run the script **before** scrolling so the `fetch` hook is in place when X loads pages.

## Bookmarklet (bookmark bar)

Same flow as Siftly v1:

1. Show the bookmark bar: **View → Show Bookmarks Bar**.
2. Right-click the bar → **Add bookmark**.
3. Name it `Export X Bookmarks v2`.
4. Paste the `javascript:` URL from [bookmarklet.txt](bookmarklet.txt) as the URL.
5. Go to `x.com/i/bookmarks` and click the bookmark.

Do not click the `javascript:` URL from a normal page — browsers block that. It only works as a bookmark.

## What you get

See [schema.md](schema.md). Short version:

```json
{
  "exportVersion": 2,
  "source": "bookmark",
  "tweets": { "<rest_id>": { /* full GraphQL tweet object */ } },
  "responses": [ { "url": "...", "data": { /* full API JSON */ } } ]
}
```

Dedup is `rest_id` only. Quoted tweets stay nested. Filter junk later.

## Verification checklist

Run this once after a capture:

1. Open `x.com/i/bookmarks`, paste `capture.js`, Auto-scroll, Export.
2. Open the downloaded JSON.
3. Confirm:
   - `exportVersion === 2`
   - `origin === "x-bookmark-export-v2"`
   - `responses.length > 0` and each `responses[i].data` is a full GraphQL blob (not a slim tweet)
   - `tweets` values are full objects with `rest_id` and `core` / `legacy` (or 2026 top-level fields)
   - There is **no** `{ id, author, handle, text }` wrapper around tweets
   - Filename is `bookmarks.json` (or `likes.json` on likes)
4. Optional: run the script again in a new session — each export is a fresh snapshot of that session (v2.0 does not merge via `localStorage`).
