import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        rh: {
          black: "#050506",
          ink: "#0a0b0f",
          card: "#101218",
          elevated: "#161922",
          line: "#252836",
          muted: "#8b90a0",
          soft: "#c4c8d4",
          white: "#f4f5f7",
          neon: "#d4ff00",
          green: "#00d66b",
          greenDim: "#00a854",
          red: "#ff4d4d",
          redDim: "#cc3d3d",
          cyan: "#3dffe8",
          violet: "#8b7cff",
        },
      },
      fontFamily: {
        sans: [
          "var(--font-geist-sans)",
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
        mono: ["var(--font-geist-mono)", "ui-monospace", "monospace"],
      },
      borderRadius: {
        rhlg: "1.25rem",
        rh: "0.875rem",
      },
      backgroundImage: {
        "mesh-hero":
          "radial-gradient(ellipse 80% 60% at 20% -10%, rgba(212,255,0,0.14), transparent 50%), radial-gradient(ellipse 60% 50% at 90% 10%, rgba(139,124,255,0.12), transparent 45%), radial-gradient(ellipse 50% 40% at 50% 100%, rgba(0,214,107,0.08), transparent 50%)",
        "card-shine":
          "linear-gradient(135deg, rgba(255,255,255,0.06) 0%, transparent 40%, transparent 60%, rgba(212,255,0,0.04) 100%)",
        "pnl-glow":
          "radial-gradient(ellipse 80% 80% at 50% 0%, rgba(212,255,0,0.1), transparent 60%)",
      },
      boxShadow: {
        glass: "0 8px 32px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06)",
        neon: "0 0 0 1px rgba(212,255,0,0.25), 0 0 28px rgba(212,255,0,0.12)",
        card: "0 4px 24px rgba(0,0,0,0.35)",
      },
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        float: "float 8s ease-in-out infinite",
      },
      keyframes: {
        float: {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-8px)" },
        },
      },
    },
  },
  plugins: [],
};
export default config;
