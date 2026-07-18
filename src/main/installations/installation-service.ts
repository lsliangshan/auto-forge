import type { InstallToolResult } from '../../shared/contracts'
import type { AppDatabase } from '../database/app-database'
import type { CatalogService } from '../catalog/catalog-service'

export class InstallationService {
  constructor(
    private readonly database: AppDatabase,
    private readonly catalog: CatalogService,
    private readonly now: () => Date = () => new Date()
  ) {}

  listInstalledToolIds(): string[] {
    return this.database.listInstalledToolIds()
  }

  install(toolId: string): InstallToolResult {
    const tool = this.catalog.findTool(toolId)
    if (!tool) throw new Error('Unknown automation tool')

    const installedAt = this.now().toISOString()
    this.database.markToolInstalled(tool.id, tool.version, installedAt)
    return { toolId: tool.id, installedAt }
  }
}
