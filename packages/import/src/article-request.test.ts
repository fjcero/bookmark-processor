import assert from "node:assert/strict";
import { test } from "node:test";
import {
  enableArticleBodyFieldToggles,
  graphqlOperationName,
  isArticleApiUrl,
  isGraphqlWriteOperation,
  isSafeArticleReplayUrl,
  requestMentionsArticle,
  withArticleBodyToggles,
} from "./article-request.ts";

test("only treats article-entity reads as article API URLs", () => {
  assert.equal(
    isArticleApiUrl("https://x.com/i/api/graphql/abc/ArticleEntityResultByRestId"),
    true,
  );
  assert.equal(
    isArticleApiUrl("https://x.com/i/api/graphql/abc/ArticleByRestId"),
    true,
  );
  assert.equal(
    isArticleApiUrl("https://x.com/i/api/graphql/abc/TweetResultByRestId"),
    false,
  );
  assert.equal(
    isArticleApiUrl("https://x.com/i/api/graphql/abc/Bookmarks"),
    false,
  );
});

test("never flags bookmark deletes as a safe article replay", () => {
  const del = "https://x.com/i/api/graphql/xyz/DeleteBookmark";
  const create = "https://x.com/i/api/graphql/xyz/CreateBookmark";
  const unbookmark = "https://x.com/i/api/graphql/xyz/UnbookmarkTweet";
  assert.equal(graphqlOperationName(del), "DeleteBookmark");
  assert.equal(isGraphqlWriteOperation(del), true);
  assert.equal(isGraphqlWriteOperation(create), true);
  assert.equal(isGraphqlWriteOperation(unbookmark), true);
  assert.equal(isArticleApiUrl(del), false);
  assert.equal(isSafeArticleReplayUrl(del), false);
  assert.equal(isSafeArticleReplayUrl(create), false);
  assert.equal(
    isGraphqlWriteOperation("https://x.com/i/api/graphql/abc/Bookmarks"),
    false,
  );
  assert.equal(
    isSafeArticleReplayUrl(
      "https://x.com/i/api/graphql/abc/ArticleEntityResultByRestId",
    ),
    true,
  );
});

test("forces withArticlePlainText on GraphQL fieldToggles", () => {
  const url = new URL("https://x.com/i/api/graphql/abc/TweetResultByRestId");
  url.searchParams.set(
    "variables",
    JSON.stringify({ tweetId: "111", articleEntityId: "222" }),
  );
  url.searchParams.set(
    "fieldToggles",
    JSON.stringify({ withArticlePlainText: false, withGrokAnalyze: false }),
  );
  const replayed = withArticleBodyToggles(url.toString());
  const toggles = JSON.parse(
    new URL(replayed.url).searchParams.get("fieldToggles") ?? "{}",
  ) as {
    withArticlePlainText?: boolean;
    withArticleRichContentState?: boolean;
  };
  assert.equal(toggles.withArticlePlainText, true);
  assert.equal(toggles.withArticleRichContentState, true);
  assert.equal(
    requestMentionsArticle(url.toString(), undefined, "222"),
    true,
  );
});

test("injects fieldToggles when the GraphQL request omitted them", () => {
  const url = new URL("https://x.com/i/api/graphql/abc/ArticleEntityResultByRestId");
  url.searchParams.set("variables", JSON.stringify({ articleId: "555" }));
  const replayed = withArticleBodyToggles(url.toString());
  const toggles = JSON.parse(
    new URL(replayed.url).searchParams.get("fieldToggles") ?? "{}",
  ) as { withArticlePlainText?: boolean; withArticleRichContentState?: boolean };
  assert.equal(toggles.withArticlePlainText, true);
  assert.equal(toggles.withArticleRichContentState, true);
});

test("adds withArticlePlainText to fieldToggles that only had rich content", () => {
  const url = new URL("https://x.com/i/api/graphql/abc/ArticleEntityResultByRestId");
  url.searchParams.set("variables", JSON.stringify({ articleId: "555" }));
  url.searchParams.set(
    "fieldToggles",
    JSON.stringify({ withArticleRichContentState: false }),
  );
  const replayed = withArticleBodyToggles(url.toString());
  const toggles = JSON.parse(
    new URL(replayed.url).searchParams.get("fieldToggles") ?? "{}",
  ) as { withArticlePlainText?: boolean; withArticleRichContentState?: boolean };
  assert.equal(toggles.withArticlePlainText, true);
  assert.equal(toggles.withArticleRichContentState, true);
});

test("walks nested fieldToggles in POST bodies", () => {
  const body = {
    variables: { articleEntityId: "555" },
    fieldToggles: { withArticlePlainText: false },
  };
  enableArticleBodyFieldToggles(body);
  assert.equal(body.fieldToggles.withArticlePlainText, true);
  assert.equal(
    (body.fieldToggles as { withArticleRichContentState?: boolean })
      .withArticleRichContentState,
    true,
  );
});

test("adds fieldToggles to GraphQL POST bodies that omitted them", () => {
  const body: {
    variables: { articleId: string };
    fieldToggles?: { withArticlePlainText?: boolean };
  } = {
    variables: { articleId: "555" },
  };
  enableArticleBodyFieldToggles(body);
  assert.equal(body.fieldToggles?.withArticlePlainText, true);
});
