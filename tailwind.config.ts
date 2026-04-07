import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/renderer/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        'canvas-bg': '#1f1e1c',
        'canvas-bg-light': '#262523',
        'focus-blue': '#4A9EFF',
        'node-border': 'rgba(255, 255, 255, 0.08)',
        'grid-dot': 'rgba(255, 255, 255, 0.13)',
        'grid-line': 'rgba(255, 255, 255, 0.05)',
        'activity-green': '#4DD964',
        'activity-orange': '#FF9F0A',
        'titlebar-bg': '#1a1917',
        // Unified warm-neutral dark grey palette
        'surface-0': '#141311',
        'surface-1': '#161513',
        'surface-2': '#181816',
        'surface-3': '#1a1917',
        'surface-4': '#1f1e1c',
        'surface-5': '#262523',
        'surface-6': '#2d2c2a',
        'surface-border': 'rgba(255, 255, 255, 0.08)',
      },
      animation: {
        'pulse-activity': 'pulseActivity 1s ease-in-out infinite alternate',
        'sidebar-view-in': 'sidebarViewIn 200ms ease-out',
      },
      keyframes: {
        pulseActivity: {
          '0%': { opacity: '0.4' },
          '100%': { opacity: '1' },
        },
        sidebarViewIn: {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
} satisfies Config
