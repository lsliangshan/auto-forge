import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/renderer/src/**/*.{vue,ts}'],
  theme: { extend: {} },
  plugins: []
} satisfies Config
