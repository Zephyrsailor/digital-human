/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'wave': 'wave 1.5s infinite linear',
      },
      keyframes: {
        wave: {
          '0%': { transform: 'scaleY(0.5)' },
          '50%': { transform: 'scaleY(1.5)' },
          '100%': { transform: 'scaleY(0.5)' },
        }
      }
    },
  },
  plugins: [],
}
