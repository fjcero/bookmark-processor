# Bookmark Processor — Chrome Extension

MV3 extension that captures X bookmarks/likes and either **sends them to your Bookmark Processor server** or **downloads JSON**.

Inspired by [chrome-extension-boilerplate-react-vite](https://github.com/Jonghakseo/chrome-extension-boilerplate-react-vite), but kept lean to fit this monorepo.

## Why an extension over a bookmarklet?

|                | Bookmarklet               | Extension                               |
| -------------- | ------------------------- | --------------------------------------- |
| Persistence    | Lost on page refresh      | `chrome.storage.local` survives refresh |
| Error recovery | try/catch per response    | Same + state restored after crash       |
| API upload     | CORS + manual server URL  | Native fetch to your server             |
| Re-activation  | Click bookmark each visit | Auto-starts on bookmarks/likes pages    |

## Build

```bash
pnpm install
pnpm --filter extension build
```

Load `apps/extension/dist` in Chrome → `chrome://extensions` → Developer mode → Load unpacked.

## Usage

1. Set **Server URL** in the popup (default `http://localhost:3000`).
2. Choose **Send to server** or **Download JSON**.
3. Open [x.com/i/bookmarks](https://x.com/i/bookmarks) or your likes page. History capture is off unless you enable it in the popup.
4. Capture starts automatically. Use **Auto-scroll**, then **Export**.

The server receives v2 JSON at `POST /api/import/capture` (CORS-enabled for x.com and `chrome-extension://` origins).

## Dev

```bash
pnpm --filter extension build:watch
```

Rebuilds on save. After each change:

1. Click **Reload** on `chrome://extensions`
2. **Hard-refresh** any open X tabs (`Cmd+Shift+R`) — stale tabs throw "Extension context invalidated"

## Troubleshooting

- **Load `apps/extension/dist`** (not `public/`). The built `content.js` and `capture-inject.js` live in `dist/`.
- **Errors after reloading the extension**: refresh the X tab. Chrome invalidates the old content-script context.
- **Sidebar missing**: wait a few seconds for X's layout, or scroll once — the panel mounts below the search box in the right column.

## Adding a future platform

X is registered from `src/background/index.ts` via `createXPlatform()`. To add LinkedIn (or similar):

1. Create `src/platforms/linkedin/` with `index.ts`, handlers, and any enrichment worker.
2. Call `registerPlatform(createLinkedInPlatform())` from `background/index.ts`, then `registerMessageHandlers` / `registerAlarmHandlers`.
3. Add host permissions and `content_scripts` in `public/manifest.json` (or a build-time manifest merge).
4. Add a parse/upload package (e.g. `packages/import-linkedin`) for that source.
5. Implement `buildStatusSlice()` — it can return empty article counts at first if the server report stays X-centric.
