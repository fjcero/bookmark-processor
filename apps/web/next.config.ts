import type { NextConfig } from 'next'
import path from 'node:path'

const nextConfig: NextConfig = {
  transpilePackages: ['@repo/import', '@repo/db'],
  serverExternalPackages: ['better-sqlite3'],
  turbopack: {
    root: path.join(__dirname, '../..'),
  },
}

export default nextConfig
