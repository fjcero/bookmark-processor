import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  articlePlainText,
  articleRestId,
  articleResultFromTweet,
  articleUrl,
  contentTypeOfTweet,
  derivePostFormat,
  findHydratedArticleResult,
  hasArticleBody,
  isArticleUnavailableDocument,
  isArticleUnavailablePayload,
  isPendingArticleRaw,
  isRicherArticlePayload,
  mergeArticleIntoTweet,
  pendingArticleFromRaw,
  hasCompleteArticleRaw,
  hasFullArticleBody,
} from "./article.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");

test("detects article stubs and flattens hydrated bodies", () => {
  const data = JSON.parse(
    readFileSync(join(fixtureDir, "mini.json"), "utf8"),
  ) as { tweets: Record<string, unknown> };
  const stub = data.tweets["1111111111111111111"];
  const hydrated = data.tweets["3333333333333333333"];
  const post = data.tweets["5555555555555555555"];

  assert.equal(contentTypeOfTweet(post), "post");
  assert.equal(contentTypeOfTweet(stub), "article");
  assert.equal(
    articleUrl(articleRestId(articleResultFromTweet(stub))!),
    "https://x.com/i/article/2222222222222222222",
  );
  assert.match(articlePlainText(articleResultFromTweet(stub)), /Why agents need documents/);
  assert.match(articlePlainText(articleResultFromTweet(stub)), /short preview/);
  assert.equal(contentTypeOfTweet(hydrated), "article");
  assert.match(
    articlePlainText(articleResultFromTweet(hydrated)),
    /First paragraph of the full article/,
  );
  assert.equal(hasArticleBody(articleResultFromTweet(stub)), false);
  assert.equal(hasArticleBody(articleResultFromTweet(hydrated)), true);
  assert.equal(derivePostFormat(stub), "original");
});

test("treats GraphQL plain_text as a hydrated article body", () => {
  const payload = {
    data: {
      article_result_by_rest_id: {
        result: {
          rest_id: "2092974442486116352",
          title: "You are not a model. Don’t price per token.",
          preview_text: "Token pricing began in the right place: the model layer.",
          plain_text:
            "Token pricing began in the right place: the model layer. When OpenAI launched its API in 2020, charging for the computation a model consumed was a sensible way to meter raw inference.\n\nThat made sense when the product was the model. It does not make sense when the product is an outcome.",
        },
      },
    },
  };
  const found = findHydratedArticleResult(payload);
  assert.equal(found?.rest_id, "2092974442486116352");
  assert.equal(hasArticleBody(found), true);
  assert.match(articlePlainText(found), /product is an outcome/);
  assert.equal(
    hasArticleBody({
      rest_id: "1",
      title: "Title",
      preview_text: "Token pricing began in the right place: the model layer.",
      plain_text: "Token pricing began in the right place: the model layer.",
    }),
    false,
  );
});

test("upgrades stub content_state blocks when GraphQL also returns longer plain_text", () => {
  const preview =
    "2.5 years ago, I picked the tech stack for @ExtendHQ with one goal: ship fast as possible.";
  const full =
    `${preview} That decision let us grow to $1M+ ARR with a team of 3. Now as volume scaled 1000x we had to rethink the database, queues, and how we shipped every week. The original stack was the right call at the time and the wrong call forever.`;
  const found = findHydratedArticleResult({
    rest_id: "222",
    title: "Lessons learned",
    preview_text: preview,
    content_state: { blocks: [{ text: preview }] },
    plain_text: full,
  });
  assert.equal(hasFullArticleBody(found), true);
  assert.match(articlePlainText(found), /wrong call forever/);
});

test("prefers a full article body when the same payload also has a stub", () => {
  const preview = "Token pricing began in the right place: the model layer.";
  const payload = {
    data: {
      tweet_results: {
        result: {
          rest_id: "111",
          article: {
            article_results: {
              result: {
                rest_id: "222",
                title: "Pricing",
                preview_text: preview,
              },
            },
          },
        },
      },
      article_result_by_rest_id: {
        result: {
          rest_id: "222",
          title: "Pricing",
          preview_text: preview,
          plain_text: `${preview} When OpenAI launched its API in 2020, charging for the computation a model consumed was a sensible way to meter raw inference.\n\nThat made sense when the product was the model. It does not make sense when the product is an outcome.`,
        },
      },
    },
  };
  const found = findHydratedArticleResult(payload);
  assert.equal(hasFullArticleBody(found), true);
  assert.match(articlePlainText(found), /product is an outcome/);
});

test("replaces stubs with richer article payloads", () => {
  const stub = {
    rest_id: "111",
    article: {
      article_results: {
        result: { rest_id: "222", title: "Title", preview_text: "Preview" },
      },
    },
  };
  const incoming = {
    rest_id: "111",
    article: {
      article_results: {
        result: {
          rest_id: "222",
          title: "Title",
          preview_text: "Preview",
          content_state: { blocks: [{ text: "Full body" }] },
        },
      },
    },
  };
  assert.equal(isRicherArticlePayload(incoming, stub), true);
  assert.equal(isRicherArticlePayload(stub, incoming), false);
  const merged = mergeArticleIntoTweet(stub, articleResultFromTweet(incoming)!);
  assert.equal(hasArticleBody(articleResultFromTweet(merged)), true);
  assert.match(articlePlainText(articleResultFromTweet(merged)), /Full body/);
  assert.equal(
    articleUrl(articleRestId(articleResultFromTweet(merged))!),
    "https://x.com/i/article/222",
  );
});

test("keeps the saved article body when a weaker refetch arrives", () => {
  const saved = {
    rest_id: "111",
    article: {
      article_results: {
        result: {
          rest_id: "222",
          title: "Title",
          content_state: { blocks: [{ text: "Full saved body that should stay" }] },
        },
      },
    },
  };
  const weaker = {
    rest_id: "111",
    article: {
      article_results: {
        result: {
          rest_id: "222",
          title: "Title",
          content_state: { blocks: [{ text: "Gone" }] },
        },
      },
    },
  };
  assert.equal(isRicherArticlePayload(weaker, saved), false);
  const merged = mergeArticleIntoTweet(saved, articleResultFromTweet(weaker)!);
  assert.match(
    articlePlainText(articleResultFromTweet(merged)),
    /Full saved body that should stay/,
  );
});

test("pending selection keeps preview-only articles until the body is full", () => {
  const stubRaw = JSON.stringify({
    rest_id: "111",
    article: {
      article_results: { result: { rest_id: "222", title: "Title" } },
    },
  });
  const previewRaw = JSON.stringify({
    rest_id: "111",
    article: {
      article_results: {
        result: {
          rest_id: "222",
          title: "Title",
          preview_text: "Short preview of the article.",
          content_state: { blocks: [{ text: "Short preview of the article." }] },
        },
      },
    },
  });
  const fullRaw = JSON.stringify({
    rest_id: "111",
    article: {
      article_results: {
        result: {
          rest_id: "222",
          title: "Title",
          preview_text: "Short preview of the article.",
          content_state: {
            blocks: [
              {
                text: "Short preview of the article. Then the real piece continues with architecture tradeoffs, the queue we rebuilt, and why the first database choice stopped working once volume scaled a thousand times over a few months.",
              },
            ],
          },
        },
      },
    },
  });
  assert.equal(isPendingArticleRaw(stubRaw, "article"), true);
  assert.equal(isPendingArticleRaw(previewRaw, "article"), true);
  assert.equal(isPendingArticleRaw(fullRaw, "article"), false);
  assert.deepEqual(pendingArticleFromRaw("111", stubRaw, null), {
    tweetId: "111",
    articleId: "222",
    url: "https://x.com/i/article/222",
  });
  assert.deepEqual(pendingArticleFromRaw("111", previewRaw, null), {
    tweetId: "111",
    articleId: "222",
    url: "https://x.com/i/article/222",
  });
  assert.equal(pendingArticleFromRaw("111", fullRaw, null), null);
  assert.equal(pendingArticleFromRaw("111", fullRaw, null, { refetch: true }), null);
  assert.equal(
    hasFullArticleBody({
      rest_id: "222",
      title: "Title",
      preview_text: "2.5 years ago, I picked the tech stack for @ExtendHQ with one goal: ship fast as possible.",
      content_state: {
        blocks: [
          {
            text: "2.5 years ago, I picked the tech stack for @ExtendHQ with one goal: ship fast as possible.",
          },
        ],
      },
    }),
    false,
  );
  assert.equal(
    hasFullArticleBody({
      rest_id: "222",
      title: "Title",
      preview_text: "2.5 years ago, I picked the tech stack.",
      content_state: {
        blocks: [
          {
            text: "2.5 years ago, I picked the tech stack for Extend with one goal: ship fast. That decision let us grow to $1M+ ARR with a team of 3. Now as volume scaled 1000x we had to rethink the database, queues, and how we shipped every week.",
          },
        ],
      },
    }),
    true,
  );
});

test("reads a stored GraphQL envelope even when the nested article is still a preview", () => {
  const preview = "Short preview of the article.";
  const rawJson = JSON.stringify({
    rest_id: "111",
    article: {
      article_results: {
        result: { rest_id: "222", title: "Title", preview_text: preview },
      },
    },
    _articleRaw: {
      data: {
        article_result_by_rest_id: {
          result: {
            rest_id: "222",
            title: "Title",
            preview_text: preview,
            plain_text: `${preview} Then the real piece continues with architecture tradeoffs, the queue we rebuilt, and why the first database choice stopped working once volume scaled a thousand times over a few months.`,
          },
        },
      },
    },
  });
  assert.equal(isPendingArticleRaw(rawJson, "article"), false);
  assert.equal(hasCompleteArticleRaw(JSON.parse(rawJson)), true);
});

test("finds hydrated article results nested in GraphQL data", () => {
  const payload = {
    data: {
      article_results: {
        result: {
          rest_id: "555",
          title: "Nested",
          content_state: { blocks: [{ text: "Secret body" }] },
        },
      },
    },
  };
  const found = findHydratedArticleResult(payload);
  assert.equal(found?.rest_id, "555");
  assert.match(articlePlainText(found), /Secret body/);
});

test("detects unavailable article pages and payloads", () => {
  assert.equal(
    isArticleUnavailableDocument({
      innerText:
        "We're unable to show this content\nThe content may be private, deleted or only available on the app.",
    }),
    true,
  );
  assert.equal(
    isArticleUnavailableDocument({
      innerText: "This article is not supported or the owner removed the article.",
    }),
    true,
  );
  assert.equal(
    isArticleUnavailableDocument({
      innerText:
        "This page is not supported.\nPlease visit the author’s profile on the latest version of X to view this content.",
    }),
    false,
  );
  assert.equal(
    isArticleUnavailablePayload({
      errors: [{ message: "Authorization: This request looks like it might be automated..." }],
    }),
    false,
  );
  assert.equal(
    isArticleUnavailablePayload({
      errors: [{ message: "This page is not supported." }],
    }),
    false,
  );
  assert.equal(
    isArticleUnavailablePayload({
      data: {
        article_results: {
          result: {
            __typename: "ArticleUnavailable",
            reason: "Deleted",
          },
        },
      },
    }),
    true,
  );
});
