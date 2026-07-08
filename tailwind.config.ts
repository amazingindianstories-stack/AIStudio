import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Lumina dark palette
        ink: {
          900: "#070708",
          850: "#0c0d0f",
          800: "#111214",
          750: "#16181b",
          700: "#1c1f23",
          650: "#23262b",
          600: "#2b2f35",
        },
        line: "rgba(255,255,255,0.07)",
        lineStrong: "rgba(255,255,255,0.12)",
        brand: {
          DEFAULT: "#ffffff",
          400: "#e5e7eb",
          500: "#d1d5db",
          600: "#9ca3af",
        },
        accent: "#f3f4f6",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
      },
      borderRadius: {
        xl: "0.875rem",
        "2xl": "1.125rem",
      },
      boxShadow: {
        panel: "0 1px 0 rgba(255,255,255,0.03) inset, 0 8px 40px rgba(0,0,0,0.45)",
        pop: "0 12px 48px rgba(0,0,0,0.55)",
        glow: "0 0 0 1px rgba(255,255,255,0.1), 0 8px 30px rgba(0,0,0,0.6)",
      },
      keyframes: {
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
        floatUp: {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        shimmer: "shimmer 1.6s infinite",
        floatUp: "floatUp 0.4s ease both",
      },
    },
  },
  plugins: [],
};

export default config;
