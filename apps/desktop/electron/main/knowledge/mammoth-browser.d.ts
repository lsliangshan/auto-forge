declare module 'mammoth/mammoth.browser.js' {
  export interface Result { value: string; messages: Array<{ type: string; message: string }> }
  export function convertToHtml(input: { arrayBuffer: ArrayBuffer }, options?: { externalFileAccess?: boolean; convertImage?: unknown }): Promise<Result>
  export const images: { imgElement(callback: (image: unknown) => Promise<{ src: string }>): unknown }
}

declare module '*?url' {
  const url: string
  export default url
}
