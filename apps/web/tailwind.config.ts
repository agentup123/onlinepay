import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef7f3',
          100: '#d6ece2',
          500: '#1f8a5b',
          600: '#18724b',
          700: '#135a3b',
          900: '#0b2f20',
        },
        ink: '#0f1720',
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', 'Segoe UI', 'Tahoma', 'Arial', 'sans-serif'],
      },
    },
  },
  plugins: [],
} satisfies Config;
