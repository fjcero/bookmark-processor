import assert from "node:assert/strict";
import { test } from "node:test";
import { parseExportV2 } from "./parse.ts";
import {
  ARTICLE_RAW_KEY,
  articleRawFrom,
  articleResultFromTweet,
  hasFullArticleBody,
  isPendingArticleRaw,
} from "./article.ts";

const FULL_BODY =
  "Token pricing began in the right place: the model layer. When OpenAI launched its API in 2020, charging for the computation a model consumed was a sensible way to meter raw inference.\n\nThat made sense when the product was the model. It does not make sense when the product is an outcome.";

function hydrationExport(opts: {
  tweetId: string;
  articleId: string;
  withCore?: boolean;
  raw?: unknown;
}) {
  const tweet: Record<string, unknown> = {
    __typename: "Tweet",
    rest_id: opts.tweetId,
    article: {
      article_results: {
        result: {
          rest_id: opts.articleId,
          title: "You are not a model.",
          preview_text: "Token pricing began in the right place.",
          plain_text: FULL_BODY,
        },
      },
    },
  };
  if (opts.withCore) {
    tweet.core = {
      user_results: {
        result: {
          rest_id: "author-1",
          core: { screen_name: "rabi_guha", name: "Rabi" },
        },
      },
    };
  }
  if (opts.raw != null) tweet[ARTICLE_RAW_KEY] = opts.raw;
  return {
    exportVersion: 2,
    source: "bookmark",
    origin: "x-article-hydrate",
    tweets: { [opts.tweetId]: tweet },
    responses:
      opts.raw != null
        ? [{ url: "https://x.com/i/article/" + opts.articleId, method: "GET", data: opts.raw }]
        : [],
  };
}

test("keeps article hydration tweets that have no core or legacy", () => {
  const parsed = parseExportV2(
    hydrationExport({ tweetId: "1111111111111111111", articleId: "2222222222222222222" }),
  );
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0]?.id, "1111111111111111111");
  assert.equal(parsed.items[0]?.contentType, "article");
  assert.match(parsed.items[0]?.text ?? "", /product is an outcome/);
  const tweet = JSON.parse(parsed.items[0]!.rawJson) as unknown;
  assert.equal(hasFullArticleBody(articleResultFromTweet(tweet)), true);
  assert.equal(isPendingArticleRaw(parsed.items[0]!.rawJson, "article"), false);
});

test("stores the raw GraphQL envelope on the tweet so the body can be re-read later", () => {
  const raw = {
    data: {
      article_result_by_rest_id: {
        result: {
          rest_id: "2222222222222222222",
          title: "You are not a model.",
          preview_text: "Token pricing began in the right place.",
          plain_text: FULL_BODY,
        },
      },
    },
  };
  const parsed = parseExportV2(
    hydrationExport({
      tweetId: "1111111111111111111",
      articleId: "2222222222222222222",
      raw,
    }),
  );
  const tweet = JSON.parse(parsed.items[0]!.rawJson) as Record<string, unknown>;
  assert.deepEqual(articleRawFrom(tweet), raw);
  assert.equal(isPendingArticleRaw(parsed.items[0]!.rawJson, "article"), false);
  assert.match(
    articleResultFromTweet(tweet)?.plain_text ?? "",
    /product is an outcome/,
  );
});

test("merges a full article body out of responses onto a stub tweet", () => {
  const parsed = parseExportV2({
    exportVersion: 2,
    source: "bookmark",
    tweets: {
      "1111111111111111111": {
        rest_id: "1111111111111111111",
        core: {
          user_results: {
            result: {
              rest_id: "author-1",
              core: { screen_name: "rabi_guha", name: "Rabi" },
            },
          },
        },
        article: {
          article_results: {
            result: {
              rest_id: "2222222222222222222",
              title: "You are not a model.",
              preview_text: "Token pricing began in the right place.",
            },
          },
        },
      },
    },
    responses: [
      {
        data: {
          article_result_by_rest_id: {
            result: {
              rest_id: "2222222222222222222",
              title: "You are not a model.",
              preview_text: "Token pricing began in the right place.",
              plain_text: FULL_BODY,
            },
          },
        },
      },
    ],
  });
  assert.equal(parsed.items.length, 1);
  assert.equal(isPendingArticleRaw(parsed.items[0]!.rawJson, "article"), false);
  assert.match(parsed.items[0]!.text, /product is an outcome/);
});
