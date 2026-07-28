/** Tailwind content scan for every frontend source module. */
export default {
  content: [
    "./index.html",
    "./App.tsx",
    "./main.tsx",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};
