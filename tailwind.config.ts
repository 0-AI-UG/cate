import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/renderer/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        'canvas-bg': '#1E1E24',
        'canvas-bg-light': '#2A2A32',
        'focus-blue': '#4A9EFF',
        'node-border': 'rgba(255, 255, 255, 0.1)',
        'grid-dot': 'rgba(255, 255, 255, 0.15)',
        'grid-line': 'rgba(255, 255, 255, 0.06)',
        'activity-green': '#4DD964',
        'activity-orange': '#FF9F0A',
        'titlebar-bg': '#28282E',
      },
      animation: {
        'pulse-activity': 'pulseActivity 1s ease-in-out infinite alternate',
      },
      keyframes: {
        pulseActivity: {
          '0%': { opacity: '0.4' },
          '100%': { opacity: '1' },
        },
      },
    },
  },
  plugins: [],
} satisfies Config
