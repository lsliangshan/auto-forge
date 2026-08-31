/* global module, process, require */

const { isAbsolute } = require('node:path')

const metadataRoot = process.env.AUTOFORGE_CONVERTER_METADATA_ROOT

if (!metadataRoot || !isAbsolute(metadataRoot)) {
  throw new Error('AUTOFORGE_CONVERTER_METADATA_ROOT must be an absolute path.')
}

module.exports = {
  extends: './electron-builder.yml',
  extraResources: [
    {
      from: 'resources/migrations',
      to: 'migrations',
    },
    {
      from: metadataRoot,
      to: 'converter-packs',
      filter: [
        'bootstrap.json',
        'index.schema.json',
        'root-public-key.pem',
      ],
    },
  ],
}
