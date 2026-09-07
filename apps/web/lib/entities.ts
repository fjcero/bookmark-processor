/**
 * Zero-cost entity extraction from stored rawJson tweet data.
 * No AI calls — pure data mining from already-stored JSON.
 */

export interface ExtractedEntities {
  hashtags: string[]
  urls: string[]
  mentions: string[]
  tools: string[]
  tweetType: 'thread' | 'reply' | 'quote' | 'original'
  hasMedia: boolean
  mediaTypes: string[]
}

const KNOWN_TOOL_DOMAINS: Record<string, string> = {
  'github.com': 'GitHub',
  'gitlab.com': 'GitLab',
  'bitbucket.org': 'Bitbucket',
  'stackoverflow.com': 'Stack Overflow',
  'replit.com': 'Replit',
  'codepen.io': 'CodePen',
  'codesandbox.io': 'CodeSandbox',
  'stackblitz.com': 'StackBlitz',
  'glitch.com': 'Glitch',
  'npmjs.com': 'npm',
  'pypi.org': 'PyPI',
  'crates.io': 'crates.io',
  'docker.com': 'Docker',
  'hub.docker.com': 'Docker Hub',
  'vercel.com': 'Vercel',
  'netlify.com': 'Netlify',
  'railway.app': 'Railway',
  'render.com': 'Render',
  'fly.io': 'Fly.io',
  'supabase.com': 'Supabase',
  'planetscale.com': 'PlanetScale',
  'neon.tech': 'Neon',
  'turso.tech': 'Turso',
  'cloudflare.com': 'Cloudflare',
  'aws.amazon.com': 'AWS',
  'console.aws.amazon.com': 'AWS',
  'cloud.google.com': 'Google Cloud',
  'azure.microsoft.com': 'Azure',
  'linear.app': 'Linear',
  'jira.atlassian.com': 'Jira',
  'atlassian.com': 'Atlassian',
  'huggingface.co': 'HuggingFace',
  'arxiv.org': 'arxiv',
  'openai.com': 'OpenAI',
  'anthropic.com': 'Anthropic',
  'replicate.com': 'Replicate',
  'perplexity.ai': 'Perplexity',
  'midjourney.com': 'Midjourney',
  'runwayml.com': 'Runway',
  'elevenlabs.io': 'ElevenLabs',
  'lmsys.org': 'LMSys',
  'together.ai': 'Together AI',
  'groq.com': 'Groq',
  'mistral.ai': 'Mistral',
  'cohere.com': 'Cohere',
  'stability.ai': 'Stability AI',
  'deepmind.google': 'DeepMind',
  'colab.research.google.com': 'Google Colab',
  'kaggle.com': 'Kaggle',
  'wandb.ai': 'Weights & Biases',
  'modal.com': 'Modal',
  'fireworks.ai': 'Fireworks AI',
  'anyscale.com': 'Anyscale',
  'cursor.sh': 'Cursor',
  'cursor.com': 'Cursor',
  'v0.dev': 'v0',
  'bolt.new': 'Bolt',
  'lovable.dev': 'Lovable',
  'devin.ai': 'Devin',
  'figma.com': 'Figma',
  'framer.com': 'Framer',
  'dribbble.com': 'Dribbble',
  'behance.net': 'Behance',
  'canva.com': 'Canva',
  'spline.design': 'Spline',
  'lottiefiles.com': 'LottieFiles',
  'notion.so': 'Notion',
  'obsidian.md': 'Obsidian',
  'roamresearch.com': 'Roam Research',
  'logseq.com': 'Logseq',
  'airtable.com': 'Airtable',
  'coda.io': 'Coda',
  'miro.com': 'Miro',
  'loom.com': 'Loom',
  'cal.com': 'Cal.com',
  'youtube.com': 'YouTube',
  'youtu.be': 'YouTube',
  'substack.com': 'Substack',
  'medium.com': 'Medium',
  'producthunt.com': 'Product Hunt',
  'app.daily.dev': 'daily.dev',
  'hackernews.com': 'Hacker News',
  'news.ycombinator.com': 'Hacker News',
  'dev.to': 'dev.to',
  'hashnode.com': 'Hashnode',
  'beehiiv.com': 'Beehiiv',
  'discord.com': 'Discord',
  'discord.gg': 'Discord',
  'slack.com': 'Slack',
  'reddit.com': 'Reddit',
  'telegram.org': 'Telegram',
  't.me': 'Telegram',
  'coinbase.com': 'Coinbase',
  'binance.com': 'Binance',
  'uniswap.org': 'Uniswap',
  'opensea.io': 'OpenSea',
  'dune.com': 'Dune Analytics',
  'etherscan.io': 'Etherscan',
  'solscan.io': 'Solscan',
  'defillama.com': 'DefiLlama',
}

function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

function detectTools(urls: string[]): string[] {
  const tools = new Set<string>()
  for (const url of urls) {
    const domain = extractDomain(url)
    if (!domain) continue
    if (KNOWN_TOOL_DOMAINS[domain]) {
      tools.add(KNOWN_TOOL_DOMAINS[domain])
      continue
    }
    for (const [knownDomain, toolName] of Object.entries(KNOWN_TOOL_DOMAINS)) {
      if (domain.endsWith(knownDomain)) {
        tools.add(toolName)
        break
      }
    }
  }
  return Array.from(tools)
}

function safeGet(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

export function extractEntities(rawJson: string): ExtractedEntities {
  const empty: ExtractedEntities = {
    hashtags: [],
    urls: [],
    mentions: [],
    tools: [],
    tweetType: 'original',
    hasMedia: false,
    mediaTypes: [],
  }

  if (!rawJson) return empty

  let tweet: unknown
  try {
    tweet = JSON.parse(rawJson)
  } catch {
    return empty
  }

  const hashtagObjs: unknown[] =
    (safeGet(tweet, 'entities', 'hashtags') as unknown[] | undefined) ??
    (safeGet(tweet, 'legacy', 'entities', 'hashtags') as unknown[] | undefined) ??
    []
  const hashtags = (hashtagObjs as Record<string, unknown>[])
    .map((h) => String(h.tag ?? h.text ?? '').toLowerCase())
    .filter(Boolean)

  const urlObjs: unknown[] =
    (safeGet(tweet, 'entities', 'urls') as unknown[] | undefined) ??
    (safeGet(tweet, 'legacy', 'entities', 'urls') as unknown[] | undefined) ??
    []
  const urls = (urlObjs as Record<string, unknown>[])
    .map((u) => String(u.expanded_url ?? u.url ?? ''))
    .filter((u) => u && !u.includes('twitter.com') && !u.includes('t.co/') && !u.includes('x.com/'))

  const mentionObjs: unknown[] =
    (safeGet(tweet, 'entities', 'user_mentions') as unknown[] | undefined) ??
    (safeGet(tweet, 'legacy', 'entities', 'user_mentions') as unknown[] | undefined) ??
    []
  const mentions = (mentionObjs as Record<string, unknown>[])
    .map((m) => String(m.screen_name ?? m.username ?? '').toLowerCase())
    .filter(Boolean)

  let tweetType: ExtractedEntities['tweetType'] = 'original'
  const inReplyToId =
    safeGet(tweet, 'in_reply_to_tweet_id') ?? safeGet(tweet, 'legacy', 'in_reply_to_status_id_str')
  const quotedStatusId =
    safeGet(tweet, 'quoted_tweet_id_str') ??
    safeGet(tweet, 'legacy', 'quoted_status_id_str') ??
    safeGet(tweet, 'quoted_status_id_str')
  const selfThread = safeGet(tweet, 'self_thread') ?? safeGet(tweet, 'legacy', 'self_thread')

  if (selfThread) tweetType = 'thread'
  else if (inReplyToId) tweetType = 'reply'
  else if (quotedStatusId) tweetType = 'quote'

  const mediaArr: unknown[] =
    (safeGet(tweet, 'entities', 'media') as unknown[] | undefined) ??
    (safeGet(tweet, 'legacy', 'entities', 'media') as unknown[] | undefined) ??
    (safeGet(tweet, 'extended_entities', 'media') as unknown[] | undefined) ??
    (safeGet(tweet, 'legacy', 'extended_entities', 'media') as unknown[] | undefined) ??
    []
  const hasMedia = mediaArr.length > 0
  const mediaTypes = [
    ...new Set((mediaArr as Record<string, unknown>[]).map((m) => String(m.type ?? ''))),
  ].filter(Boolean)

  const tools = detectTools(urls)

  return { hashtags, urls, mentions, tools, tweetType, hasMedia, mediaTypes }
}
