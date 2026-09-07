/**
 * X Bookmark Export v2 — console script
 *
 * Fork of Siftly's bookmarklet (app/import/page.tsx). Same UX:
 * purple Export button + Auto-scroll, JSON download via Blob.
 *
 * Difference: stores full GraphQL tweet objects + raw API responses.
 * Paste this into DevTools console on x.com/i/bookmarks or /username/likes.
 */
(async function () {
  if (!location.hostname.includes('twitter.com') && !location.hostname.includes('x.com')) {
    alert('Run this on x.com/i/bookmarks or x.com/username/likes');
    return;
  }

  const isLikes = location.pathname.includes('/likes');
  const source = isLikes ? 'like' : 'bookmark';
  const label = isLikes ? 'likes' : 'bookmarks';
  const tweets = {};
  const responses = [];
  const seen = new Set();

  function tweetCount() {
    return Object.keys(tweets).length;
  }

  function addTweet(t) {
    if (!t?.rest_id || seen.has(t.rest_id)) return;
    seen.add(t.rest_id);
    tweets[t.rest_id] = t;
    btn.textContent = `Export ${tweetCount()} ${label} →`;
  }

  function isTweetObj(o) {
    return (
      o &&
      typeof o === 'object' &&
      typeof o.rest_id === 'string' &&
      o.rest_id.length > 5 &&
      (o.legacy || o.core)
    );
  }

  function unwrapTweet(t) {
    if (!t) return null;
    if (
      t.__typename === 'TweetWithVisibilityResults' ||
      t.__typename === 'TweetWithVisibilityResult'
    ) {
      return t.tweet ?? t;
    }
    return t;
  }

  function deepFindTweets(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 12) return;
    if (Array.isArray(obj)) {
      obj.forEach((item) => deepFindTweets(item, depth + 1));
      return;
    }
    if (obj.tweet_results?.result) {
      const tw = unwrapTweet(obj.tweet_results.result);
      if (tw) addTweet(tw);
    } else if (isTweetObj(obj)) {
      addTweet(unwrapTweet(obj));
    }
    for (const k of Object.keys(obj)) {
      if (k !== 'quoted_status_result') deepFindTweets(obj[k], depth + 1);
    }
  }

  function processData(d, url, method) {
    responses.push({
      url: url || '',
      method: method || 'GET',
      capturedAt: new Date().toISOString(),
      data: d,
    });
    deepFindTweets(d, 0);
  }

  const btn = document.createElement('button');
  btn.textContent = 'Scroll then click to Export →';
  Object.assign(btn.style, {
    position: 'fixed',
    top: '12px',
    right: '12px',
    zIndex: '2147483647',
    padding: '10px 18px',
    background: '#4f46e5',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: '700',
    boxShadow: '0 0 0 2px rgba(99,102,241,.4),0 4px 16px rgba(0,0,0,.4)',
    fontFamily: 'system-ui,sans-serif',
  });

  function doExport() {
    window.fetch = origFetch;
    XMLHttpRequest.prototype.open = origOpen;
    XMLHttpRequest.prototype.send = origSend;
    [btn, autoBtn].forEach((el) => {
      try {
        document.body.removeChild(el);
      } catch (e) {}
    });
    if (!tweetCount()) {
      alert(`No ${label} captured. Use Auto-scroll or scroll manually first.`);
      return;
    }
    const payload = {
      exportVersion: 2,
      exportedAt: new Date().toISOString(),
      source,
      origin: 'x-bookmark-export-v2',
      page: { url: location.href, pathname: location.pathname },
      stats: { tweetCount: tweetCount(), responseCount: responses.length },
      tweets,
      responses,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${source}s.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    console.log(`✅ Downloaded ${tweetCount()} ${label} (${responses.length} API responses)!`);
  }

  btn.onclick = doExport;

  const autoBtn = document.createElement('button');
  autoBtn.textContent = '▶ Auto-scroll';
  Object.assign(autoBtn.style, {
    position: 'fixed',
    top: '58px',
    right: '12px',
    zIndex: '2147483647',
    padding: '8px 14px',
    background: '#18181b',
    color: '#a1a1aa',
    border: '1px solid #3f3f46',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '12px',
    fontWeight: '600',
    fontFamily: 'system-ui,sans-serif',
  });

  let autoScrolling = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function runAutoScroll() {
    let stagnant = 0;
    let lastCount = tweetCount();
    while (autoScrolling) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      const col = document.querySelector('[data-testid="primaryColumn"]');
      col?.scrollTo(0, col.scrollHeight);
      await sleep(900);
      if (tweetCount() > lastCount) {
        stagnant = 0;
        lastCount = tweetCount();
      } else {
        stagnant++;
        if (stagnant >= 8) {
          window.scrollTo(0, document.documentElement.scrollHeight);
          await sleep(2000);
          if (tweetCount() === lastCount) {
            autoScrolling = false;
            autoBtn.textContent = `✅ Done — ${tweetCount()} captured`;
            autoBtn.style.cssText += ';background:#14532d;color:#86efac;border:1px solid #166534';
            console.log(`✅ Auto-scroll complete! ${tweetCount()} ${label} ready. Click Export.`);
            return;
          }
          stagnant = 0;
        }
      }
    }
    autoBtn.textContent = '▶ Auto-scroll';
    autoBtn.style.background = '#18181b';
    autoBtn.style.color = '#a1a1aa';
    autoBtn.style.border = '1px solid #3f3f46';
  }

  autoBtn.onclick = function () {
    if (autoScrolling) {
      autoScrolling = false;
      return;
    }
    autoScrolling = true;
    autoBtn.textContent = '⏸ Stop';
    autoBtn.style.background = '#4f46e5';
    autoBtn.style.color = '#fff';
    autoBtn.style.border = 'none';
    runAutoScroll();
  };

  document.body.appendChild(btn);
  document.body.appendChild(autoBtn);

  const isApiUrl = (u) =>
    u.includes('/graphql/') || u.includes('/i/api/') || u.includes('/2/timeline');

  function requestUrl(arg) {
    return arg instanceof Request ? arg.url : String(arg);
  }

  function requestMethod(arg, init) {
    if (arg instanceof Request) return arg.method || 'GET';
    return (init && init.method) || 'GET';
  }

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const r = await origFetch.apply(this, args);
    try {
      const u = requestUrl(args[0]);
      if (isApiUrl(u)) {
        const ct = r.headers.get('content-type') ?? '';
        if (ct.includes('json')) {
          const d = await r.clone().json();
          processData(d, u, requestMethod(args[0], args[1]));
        }
      }
    } catch (e) {}
    return r;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const xhrMeta = new WeakMap();
  XMLHttpRequest.prototype.open = function (...args) {
    xhrMeta.set(this, { method: String(args[0] ?? 'GET'), url: String(args[1] ?? '') });
    return origOpen.apply(this, args);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const xhr = this;
    const meta = xhrMeta.get(xhr) ?? { method: 'GET', url: '' };
    if (isApiUrl(meta.url)) {
      xhr.addEventListener('load', function () {
        try {
          processData(JSON.parse(xhr.responseText), meta.url, meta.method);
        } catch (e) {}
      });
    }
    return origSend.apply(this, args);
  };

  console.log(`✅ v2 script active. Scroll through your ${label}, then click the purple button.`);
})();
