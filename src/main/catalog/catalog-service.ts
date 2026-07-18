import { readFileSync } from 'node:fs'
import type { ToolSummary } from '../../shared/catalog'

export class CatalogService {
  private readonly tools: ToolSummary[]

  constructor(catalogPath: string) {
    this.tools = JSON.parse(readFileSync(catalogPath, 'utf8')) as ToolSummary[]
  }

  listTools(): ToolSummary[] {
    return structuredClone(this.tools)
  }

  findTool(toolId: string): ToolSummary | undefined {
    return this.tools.find(({ id }) => id === toolId)
  }
}
