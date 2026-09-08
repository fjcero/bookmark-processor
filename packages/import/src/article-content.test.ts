import assert from 'node:assert/strict'
import test from 'node:test'
import { parseArticleContent, parseArticleContentFromRaw } from './article-content.ts'

const sampleArticle = {
  rest_id: '2052734499319091384',
  title: 'first principles thinking',
  cover_media: {
    media_info: { original_img_url: 'https://pbs.twimg.com/media/cover.jpg' },
  },
  media_entities: [
    {
      media_id: '111',
      media_info: { original_img_url: 'https://pbs.twimg.com/media/inline.jpg' },
    },
  ],
  content_state: {
    blocks: [
      { type: 'unstyled', text: 'Intro paragraph.' },
      { type: 'header-two', text: 'Section title' },
      {
        type: 'atomic',
        text: ' ',
        entityRanges: [{ key: 0, offset: 0, length: 1 }],
      },
      {
        type: 'atomic',
        text: ' ',
        entityRanges: [{ key: 1, offset: 0, length: 1 }],
      },
      { type: 'unstyled', text: 'After embed.' },
    ],
    entityMap: [
      {
        key: '0',
        value: {
          type: 'MEDIA',
          data: { mediaItems: [{ mediaId: '111' }] },
        },
      },
      {
        key: '1',
        value: {
          type: 'TWEET',
          data: { tweetId: '1465786605889892356' },
        },
      },
    ],
  },
}

test('parseArticleContent renders paragraphs, headings, images, and tweet embeds', () => {
  const parsed = parseArticleContent(sampleArticle)
  assert.ok(parsed)
  assert.equal(parsed.coverUrl, 'https://pbs.twimg.com/media/cover.jpg')
  assert.deepEqual(parsed.nodes, [
    { type: 'paragraph', text: 'Intro paragraph.' },
    { type: 'heading', text: 'Section title', level: 2 },
    { type: 'image', url: 'https://pbs.twimg.com/media/inline.jpg' },
    {
      type: 'tweet',
      tweetId: '1465786605889892356',
      url: 'https://x.com/i/status/1465786605889892356',
    },
    { type: 'paragraph', text: 'After embed.' },
  ])
})

test('parseArticleContentFromRaw reads article data from stored tweet json', () => {
  const raw = JSON.stringify({
    article: { article_results: { result: sampleArticle } },
  })
  const parsed = parseArticleContentFromRaw(raw)
  assert.ok(parsed)
  assert.equal(parsed.nodes.length, 5)
})
