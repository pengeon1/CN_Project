/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: {
          blue: '#18A0FB',
          darkBlue: '#1E293B',
          canvasBg: '#F8FAFC',
        },
      },
    },
  },
  plugins: [],
};
