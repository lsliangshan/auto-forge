import { describe, expect, it } from 'vitest'
import { filterTools, type ToolSummary } from './catalog'

const seed: ToolSummary[] = [
  {
    id: 'web-collector',
    name: '网页数据采集器',
    description: '从网页中采集结构化数据',
    developer: 'AutoForge 团队',
    version: '2.3.1',
    category: 'data',
    tags: ['智能识别'],
    platforms: ['windows', 'macos', 'linux'],
    downloads: 128600,
    featured: true,
    permissions: []
  },
  {
    id: 'content-publisher',
    name: '定时内容发布',
    description: '定时发布内容到多个平台',
    developer: 'AutoForge 团队',
    version: '1.4.0',
    category: 'publishing',
    tags: ['定时任务'],
    platforms: ['windows', 'macos'],
    downloads: 64600,
    featured: false,
    permissions: []
  }
]

describe('filterTools', () => {
  it('filters tools by normalized query and category', () => {
    expect(filterTools(seed, ' 网页 ', 'data')).toEqual([seed[0]])
  })

  it('returns all tools when filters are empty', () => {
    expect(filterTools(seed, '', 'all')).toEqual(seed)
  })
})
