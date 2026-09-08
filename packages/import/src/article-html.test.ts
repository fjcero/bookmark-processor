import assert from "node:assert/strict";
import { test } from "node:test";
import {
  articleFromPageContent,
  isSubstantialArticleBody,
  splitArticlePageText,
} from "./article-html.ts";
import { articlePlainText, hasArticleBody } from "./article.ts";

const innerText = [
  "Home",
  "Article",
  "You are not a model. Don’t price per token.",
  "Sarah Wang",
  "@sarahdingwang",
  "Sep 7",
  "Token pricing began in the right place: the model layer. When OpenAI launched its API in 2020, charging for the computation a model consumed was a sensible way to meter raw inference.",
  "That made sense when the product was the model. It does not make sense when the product is an outcome.",
  "Credits tied to recognizable value beat tokens nearly two to one among technical buyers.",
  "12K",
  "234",
  "Reply",
].join("\n");

test("splits X article chrome from title and body paragraphs", () => {
  const split = splitArticlePageText(innerText);
  assert.equal(split.title, "You are not a model. Don’t price per token.");
  assert.equal(split.paragraphs.length, 3);
  assert.match(split.paragraphs[0] ?? "", /Token pricing began/);
  assert.equal(isSubstantialArticleBody(split.title, split.paragraphs), true);
});

test("rejects title-plus-preview stubs", () => {
  const stub = splitArticlePageText(
    [
      "Article",
      "You are not a model. Don’t price per token.",
      "Sarah Wang",
      "@sarahdingwang",
      "Token pricing began in the right place: the model layer.",
    ].join("\n"),
  );
  assert.equal(isSubstantialArticleBody(stub.title, stub.paragraphs), false);
  assert.equal(
    articleFromPageContent({
      articleId: "2092974442486116352",
      innerText: stub.title + "\n" + stub.paragraphs.join("\n"),
    }),
    null,
  );
});

test("builds a cacheable article result from rendered HTML text", () => {
  const article = articleFromPageContent({
    articleId: "2092974442486116352",
    innerText,
    html: "<article><h1>You are not a model. Don’t price per token.</h1><p>Token pricing began</p><script>alert(1)</script></article>",
    imageUrls: [
      "https://pbs.twimg.com/media/cover.jpg",
      "https://pbs.twimg.com/profile_images/avatar.jpg",
      "https://pbs.twimg.com/media/figure.png",
    ],
  });
  assert.ok(article);
  assert.equal(article?.hydration_source, "html");
  assert.equal(article?.rest_id, "2092974442486116352");
  assert.equal(hasArticleBody(article), true);
  assert.match(articlePlainText(article), /outcome/);
  assert.equal(
    article?.cover_media?.media_info?.original_img_url,
    "https://pbs.twimg.com/media/cover.jpg",
  );
  assert.deepEqual(
    article?.media_entities?.map((entity) => entity.media_info?.original_img_url),
    ["https://pbs.twimg.com/media/figure.png"],
  );
  assert.match(article?.extracted_html ?? "", /<article>/);
  assert.doesNotMatch(article?.extracted_html ?? "", /<script>/);
});
