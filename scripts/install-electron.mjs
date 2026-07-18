process.env.ELECTRON_MIRROR ??= 'https://npmmirror.com/mirrors/electron/'

await import('electron/install.js')
