declare module 'mammoth/mammoth.browser.js' {
  interface MammothImage {
    contentType: string
    read(encoding: 'base64'): Promise<string>
  }

  export const images: {
    imgElement(converter: (image: MammothImage) => Promise<{ src: string }>): unknown
  }

  export function convertToHtml(
    input: { arrayBuffer: ArrayBuffer },
    options: { externalFileAccess: boolean; convertImage: unknown },
  ): Promise<{ value: string }>
}
