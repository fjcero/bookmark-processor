import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SORT_INDEX_KEY,
  applySortIndexes,
  collectSortIndexes,
  compareSortIndex,
  normalizeSortIndex,
  sortIndexFromTweet,
} from "./sort-index.ts";

const payload = {
  data: {
    bookmark_timeline_v2: {
      timeline: {
        instructions: [
          {
            type: "TimelineAddEntries",
            entries: [
              {
                entryId: "tweet-111",
                sortIndex: "2000000000000000001",
                content: {
                  itemContent: {
                    tweet_results: {
                      result: { rest_id: "111", legacy: { full_text: "new" } },
                    },
                  },
                },
              },
              {
                entryId: "tweet-222",
                sortIndex: "1000000000000000001",
                content: {
                  itemContent: {
                    tweet_results: {
                      result: {
                        __typename: "TweetWithVisibilityResults",
                        tweet: { rest_id: "222", core: {} },
                      },
                    },
                  },
                },
              },
            ],
          },
        ],
      },
    },
  },
};

test("reads sortIndex from bookmark timeline entries", () => {
  const found = collectSortIndexes(payload);
  assert.equal(found.get("111"), "2000000000000000001");
  assert.equal(found.get("222"), "1000000000000000001");
});

test("stamps the higher sortIndex onto captured tweets", () => {
  const tweets: Record<string, unknown> = {
    "111": { rest_id: "111", legacy: { full_text: "new" } },
    "222": { rest_id: "222", [SORT_INDEX_KEY]: "1" },
  };
  applySortIndexes(tweets, [{ url: "https://x.com/i/api/graphql/x", data: payload.data }]);
  assert.equal(sortIndexFromTweet(tweets["111"]), "2000000000000000001");
  assert.equal(sortIndexFromTweet(tweets["222"]), "1000000000000000001");
});

test("compares snowflake sort indexes by magnitude", () => {
  assert.ok(compareSortIndex("200", "100") > 0);
  assert.ok(compareSortIndex("999", "1000") < 0);
  assert.equal(normalizeSortIndex("abc"), null);
});
