import { describe, expect, it } from 'vitest'
import { attachmentDialogOptions } from './attachment-dialog-options.js'

describe('attachmentDialogOptions', () => {
  it('lets users choose any attachment without extension filtering', () => {
    expect(attachmentDialogOptions).toEqual({
      title: '选择附件',
      properties: ['openFile', 'multiSelections'],
    })
    expect(attachmentDialogOptions).not.toHaveProperty('filters')
  })
})
