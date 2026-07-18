export type ToolCategory = 'all' | 'data' | 'publishing' | 'productivity' | 'developer'
export type ToolPlatform = 'windows' | 'macos' | 'linux'

export interface ToolPermission {
  id: string
  label: string
  description: string
}

export interface ToolSummary {
  id: string
  name: string
  description: string
  developer: string
  version: string
  category: Exclude<ToolCategory, 'all'>
  tags: string[]
  platforms: ToolPlatform[]
  downloads: number
  featured: boolean
  permissions: ToolPermission[]
}

export function filterTools(
  tools: ToolSummary[],
  query: string,
  category: ToolCategory
): ToolSummary[] {
  const needle = query.trim().toLocaleLowerCase('zh-CN')

  return tools.filter((tool) => {
    const matchesCategory = category === 'all' || tool.category === category
    const searchable = `${tool.name} ${tool.description} ${tool.developer} ${tool.tags.join(' ')}`
      .toLocaleLowerCase('zh-CN')
    return matchesCategory && (!needle || searchable.includes(needle))
  })
}
