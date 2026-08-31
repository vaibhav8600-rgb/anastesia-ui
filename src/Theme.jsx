import { useCallback, useEffect, useState } from "react";

// Two looks, switchable: the glass-and-neumorphism default, and the flat one
// this project wore before it. Both are pure token sets in styles.css, so the
// switch only has to set an attribute — no component knows which is on.

const KEY = "anastasia-theme";
// Same correction as the colour store: fall back to the misspelled key once,
// so nobody's chosen theme resets because we fixed our own spelling.
const KEY_WAS = "anastesia-theme";
const THEMES = ["glass", "flat"];

export function useTheme() {
  const [theme, setTheme] = useState(() => {
    // A private window, or a browser with site data blocked, throws on read.
    try {
      const saved = localStorage.getItem(KEY) ?? localStorage.getItem(KEY_WAS);
      return THEMES.includes(saved) ? saved : THEMES[0];
    } catch {
      return THEMES[0];
    }
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(KEY, theme); } catch { /* not worth failing over */ }
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((t) => THEMES[(THEMES.indexOf(t) + 1) % THEMES.length]);
  }, []);

  return { theme, toggle };
}

export default function ThemeToggle({ theme, onToggle }) {
  const next = theme === "glass" ? "flat" : "glass";
  return (
    <button
      type="button"
      className="theme-btn"
      onClick={onToggle}
      title={`Switch to the ${next} theme`}
      aria-label={`Theme: ${theme}. Switch to ${next}.`}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {theme === "glass" ? (
          <>
            <rect x="3" y="4" width="14" height="14" rx="3" />
            <path d="M9 10h12v10H11" />
          </>
        ) : (
          <>
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M3 10h18" />
          </>
        )}
      </svg>
      {theme === "glass" ? "Glass" : "Flat"}
    </button>
  );
}
