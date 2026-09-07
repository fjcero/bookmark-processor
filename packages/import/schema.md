# X Bookmark Export v2 — JSON schema

Standalone fork of the Siftly bookmarklet. Capture-everything, trim-nothing.

Filename: `bookmarks.json` on `/i/bookmarks`, `likes.json` on `/username/likes`.

## Top-level object

```json
{
  "exportVersion": 2,
  "exportedAt": "2026-09-06T20:00:00.000Z",
  "source": "bookmark",
  "origin": "x-bookmark-export-v2",
  "page": {
    "url": "https://x.com/i/bookmarks",
    "pathname": "/i/bookmarks"
  },
  "stats": {
    "tweetCount": 20,
    "responseCount": 4
  },
  "tweets": {},
  "responses": []
}
```

| Field | Type | Description |
|-------|------|-------------|
| `exportVersion` | `2` | Distinguishes this format from v1 `{ bookmarks: [...] }` |
| `exportedAt` | ISO-8601 string | When Export was clicked |
| `source` | `"bookmark"` \| `"like"` | From the page pathname |
| `origin` | `"x-bookmark-export-v2"` | Producer id |
| `page.url` | string | `location.href` at export time |
| `page.pathname` | string | `location.pathname` |
| `stats.tweetCount` | number | `Object.keys(tweets).length` |
| `stats.responseCount` | number | `responses.length` |
| `tweets` | object map | Full GraphQL tweet objects, keyed by `rest_id` |
| `responses` | array | Every intercepted GraphQL / i/api / timeline JSON blob |

## `tweets`

Object map, not an array. Keys are tweet `rest_id` strings. Values are the **full** `tweet_results.result` objects after unwrapping `TweetWithVisibilityResults`.

Typical nested fields you will see (not extracted at capture time):

- `rest_id`
- `legacy` — may be a dict, `null`, or incomplete on the 2026 X schema
- `core.user_results.result.core` — 2026 user fields (`screen_name`, `name`)
- `core.user_results.result.legacy` — older user fields
- `note_tweet` — long-form text
- `article` — X Articles
- `quoted_status_result` — quoted tweet (kept inside the parent object)
- `views`, cards, entities, media, engagement counts

Dedup: the same `rest_id` on multiple pages is stored once (last write wins). Quoted tweets are **not** promoted to top-level keys unless they also appear as their own timeline entries. They remain nested on the parent tweet and in `responses`.

No field trimming. Junk objects that have a `rest_id` plus `legacy` or `core` may appear; filter downstream.

## `responses[]`

Each item:

```json
{
  "url": "https://x.com/i/api/graphql/.../Bookmarks?...",
  "method": "GET",
  "capturedAt": "2026-09-06T20:01:12.000Z",
  "data": {}
}
```

| Field | Description |
|-------|-------------|
| `url` | Request URL that matched `/graphql/`, `/i/api/`, or `/2/timeline` |
| `method` | HTTP method (`GET`, `POST`, …) |
| `capturedAt` | When the response was intercepted |
| `data` | Parsed JSON body, **verbatim** — timeline instructions, cursors, ads, folder metadata if X sent it |

`responses` is an audit trail. The same tweet can appear in multiple page blobs; `tweets` is the deduped index.

## Incremental re-runs (not implemented in v2.0)

v2.0 starts a fresh capture each time you run the script. Export always downloads a complete snapshot of **this session**.

A later version could persist state in `localStorage` under `x-export-v2-state`:

```json
{
  "seenTweetIds": ["2095911123291881608"],
  "lastExportAt": "2026-09-06T20:00:00.000Z"
}
```

Suggested merge rules if you add this:

- Tweet map: union by `rest_id` (keep newer object)
- `responses`: always append (do not collapse the audit trail)
- Filename / download UX: unchanged

Until then, re-run on a full scroll if you need a complete file.

## v1 vs v2

| | v1 (Siftly) | v2 |
|--|-------------|-----|
| Shape | `{ bookmarks: [...], source }` | `{ exportVersion: 2, tweets: {}, responses: [], ... }` |
| Tweet records | Slim `{ id, author, handle, text, media, ... }` | Full GraphQL objects |
| API payloads | Discarded after extraction | Stored in `responses` |
| Download | `bookmarks.json` / `likes.json` via Blob | Same |
