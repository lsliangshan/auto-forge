import type { OpenDialogOptions } from 'electron'

export const attachmentDialogOptions: OpenDialogOptions = {
  title: '选择附件',
  properties: ['openFile', 'multiSelections'],
}
