type WindowOpenDetails = {
  url: string
}

type InlineWindowOpenHandler = (details: WindowOpenDetails) => { action: 'deny' }

export function createInlineWindowOpenHandler(
  loadUrl: (url: string) => Promise<unknown> | unknown
): InlineWindowOpenHandler {
  return ({ url }) => {
    void loadUrl(url)
    return { action: 'deny' }
  }
}
