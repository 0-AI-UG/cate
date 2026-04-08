import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/renderer/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        'canvas-bg': 'var(--canvas-bg)',
        'canvas-bg-light': 'var(--canvas-bg-alt)',
        'focus-blue': 'var(--focus-blue)',
        'node-border': 'var(--border-subtle)',
        'grid-dot': 'var(--grid-dot)',
        'grid-line': 'var(--grid-line)',
        'activity-green': 'var(--activity-green)',
        'activity-orange': 'var(--activity-orange)',
        'titlebar-bg': 'var(--titlebar-bg)',
        'surface-0': 'var(--surface-0)',
        'surface-1': 'var(--surface-1)',
        'surface-2': 'var(--surface-2)',
        'surface-3': 'var(--surface-3)',
        'surface-4': 'var(--surface-4)',
        'surface-5': 'var(--surface-5)',
        'surface-6': 'var(--surface-6)',
        'surface-border': 'var(--border-subtle)',
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
