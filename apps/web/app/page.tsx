import { getItems, getStats } from '@/lib/queries'
import HomeClient from './home-client'

export const dynamic = 'force-dynamic'

export default async function HomePage() {
  const [stats, items] = await Promise.all([getStats(), getItems(40)])

  return (
    <HomeClient
      initialStats={stats}
      initialItems={items.map((item) => ({
        id: item.id,
        tweetId: item.tweetId,
        text: item.text,
        source: item.source,
        tweetCreatedAt: item.tweetCreatedAt?.toISOString() ?? null,
        entitiesAt: item.entitiesAt?.toISOString() ?? null,
        understandingAt: item.understandingAt?.toISOString() ?? null,
        categorizedAt: item.categorizedAt?.toISOString() ?? null,
        understanding: item.understanding,
        handle: item.handle,
        name: item.name,
        avatarUrl: item.avatarUrl,
        categories: item.categories,
      }))}
    />
  )
}
