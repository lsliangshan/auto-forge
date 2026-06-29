import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/renderer/src/**/*.{vue,ts}'],
  theme: {
    extend: {
      colors: {
        forge: {
          ink: '#1f2933',
          line: '#d6dde6',
          mint: '#0f9f8f',
          amber: '#c47a11',
          rose: '#c2415b'
        }
      },
      boxShadow: {
        panel: '0 12px 36px rgb(31 41 51 / 0.08)'
      }
    }
  },
  plugins: []
} satisfies Config
