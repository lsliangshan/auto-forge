declare module 'mammoth/mammoth.browser.js' {
  export const images: {
    imgElement(converter: (image: unknown) => Promise<{ src: string }>): unknown
  }

  export function convertToHtml(
    input: { arrayBuffer: ArrayBuffer },
    options: { externalFileAccess: boolean; convertImage: unknown },
  ): Promise<{ value: string }>
}
