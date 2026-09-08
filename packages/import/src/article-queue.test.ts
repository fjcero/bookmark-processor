import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ARTICLE_MAX_ATTEMPTS,
  enqueueArticles,
  isTerminalArticleFailure,
  markArticleFailure,
  markArticleFetching,
  markArticleRemoved,
  markArticleSuccess,
  pickNextArticle,
  retryFailedArticles,
  type ArticleQueueItem,
} from "./article-queue.ts";

function seed(): ArticleQueueItem[] {
  return enqueueArticles([], [
    { tweetId: "t1", articleId: "a1", url: "https://x.com/i/article/a1" },
  ]);
}

test("picks pending articles and retries with backoff until terminal failure", () => {
  let queue = seed();
  const first = pickNextArticle(queue, 0);
  assert.equal(first?.articleId, "a1");
  queue = markArticleFetching(queue, "a1");
  assert.equal(pickNextArticle(queue, 0), null);

  queue = markArticleFailure(queue, "a1", "timeout", 1_000);
  assert.equal(queue[0]?.status, "pending");
  assert.equal(pickNextArticle(queue, 1_000), null);
  assert.ok((queue[0]?.nextAt ?? 0) > 1_000);

  queue = markArticleSuccess(queue, "a1");
  assert.equal(queue[0]?.status, "ok");
  assert.equal(pickNextArticle(queue, Date.now()), null);
});

test("stops retrying after max attempts", () => {
  let queue = seed();
  const now = 10_000;
  for (let i = 0; i < ARTICLE_MAX_ATTEMPTS; i++) {
    queue = markArticleFetching(queue, "a1");
    queue = markArticleFailure(queue, "a1", "blocked", now);
  }
  assert.equal(queue[0]?.status, "failed");
  assert.equal(isTerminalArticleFailure(queue[0]!), true);
  assert.equal(pickNextArticle(queue, now + 9_999_999), null);

  queue = retryFailedArticles(queue, now);
  assert.equal(queue[0]?.status, "pending");
  assert.equal(queue[0]?.attempts, 0);
  assert.ok((queue[0]?.nextAt ?? 0) > now);
});

test("re-enqueues successful articles when the server still lists them", () => {
  let queue = seed();
  queue = markArticleFetching(queue, "a1");
  queue = markArticleSuccess(queue, "a1");
  queue = enqueueArticles(queue, [
    { tweetId: "t1", articleId: "a1", url: "https://x.com/i/article/a1" },
  ]);
  assert.equal(queue.length, 1);
  assert.equal(queue[0]?.status, "pending");
  assert.equal(queue[0]?.attempts, 0);
});

test("refetch resets failed and in-flight articles", () => {
  let queue = seed();
  queue = markArticleFetching(queue, "a1");
  queue = markArticleFailure(queue, "a1", "blocked", 10_000);
  queue[0]!.status = "failed";
  queue[0]!.attempts = ARTICLE_MAX_ATTEMPTS;
  queue = enqueueArticles(queue, [
    {
      tweetId: "t1",
      articleId: "a1",
      url: "https://x.com/i/article/a1",
      refetch: true,
    },
  ]);
  assert.equal(queue[0]?.status, "pending");
  assert.equal(queue[0]?.attempts, 0);
  assert.equal(queue[0]?.nextAt, undefined);
});

test("removes unavailable articles from the queue", () => {
  let queue = enqueueArticles([], [
    { tweetId: "t1", articleId: "a1", url: "https://x.com/i/article/a1" },
    { tweetId: "t2", articleId: "a2", url: "https://x.com/i/article/a2" },
  ]);
  queue = markArticleRemoved(queue, "a1");
  assert.equal(queue.length, 1);
  assert.equal(queue[0]?.articleId, "a2");
});
