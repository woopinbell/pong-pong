import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0b2559",
        muted: "#62708d",
        line: "#d8e1ef",
        panel: "#ffffff",
        blue: {
          600: "#1768f2",
          700: "#0f56d8"
        },
        green: {
          500: "#12b76a",
          600: "#079455"
        }
      },
      boxShadow: {
        card: "0 10px 30px rgba(15, 36, 78, 0.08)"
      }
    }
  },
  plugins: []
};

export default config;
