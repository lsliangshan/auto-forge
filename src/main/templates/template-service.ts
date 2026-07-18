import { cpSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const templateDirectoryName = 'auto-forge-tool-template'

export class TemplateService {
  private readonly sourceDirectory: string

  constructor(sourceDirectory: string) {
    this.sourceDirectory = realpathSync(sourceDirectory)
  }

  exportTemplate(targetDirectory: string): string {
    const resolvedTarget = resolve(targetDirectory)
    if (!existsSync(resolvedTarget) || !lstatSync(resolvedTarget).isDirectory()) {
      throw new Error('Target directory does not exist')
    }

    const destination = join(resolvedTarget, templateDirectoryName)
    if (existsSync(destination)) throw new Error(`${templateDirectoryName} already exists`)

    mkdirSync(destination)
    cpSync(this.sourceDirectory, destination, {
      recursive: true,
      errorOnExist: true,
      filter: (source) => basename(source) !== '.DS_Store'
    })
    return destination
  }
}
