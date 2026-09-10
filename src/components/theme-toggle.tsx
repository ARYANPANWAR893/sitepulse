"use client";

import { useEffect, useState } from "react";

export type Theme = "system" | "light" | "dark";

export const THEME_KEY = "sitepulse-theme";

/** Cycles system → light → dark → system. */
const NEXT: Record<Theme, Theme> = {
  system: "light",
  light: "dark",
  dark: "system",
};

const LABEL: Record<Theme, string> = {
  system: "Match system",
  light: "Light",
  dark: "Dark",
};

function apply(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  try {
    if (theme === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* private mode / storage blocked — the in-page choice still applies */
  }
}

export function ThemeToggle({ className = "" }: { className?: string }) {
  // Start as "system" to match what the server rendered; the inline script in
  // layout.tsx has already set data-theme, so we only need to read it back.
  const [theme, setTheme] = useState<Theme>("system");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(THEME_KEY);
    } catch {
      /* ignore */
    }
    if (stored === "light" || stored === "dark") setTheme(stored);
    setMounted(true);
  }, []);

  function onClick() {
    const next = NEXT[theme];
    setTheme(next);
    apply(next);
  }

  const next = NEXT[theme];

  return (
    <button
      type="button"
      onClick={onClick}
      // Before mount the stored value is unknown, so don't announce a wrong
      // state to a screen reader — the icon is decorative until then.
      aria-label={mounted ? `Theme: ${LABEL[theme]}. Switch to ${LABEL[next]}.` : "Theme"}
      title={mounted ? `Theme: ${LABEL[theme]} — click for ${LABEL[next]}` : "Theme"}
      className={`grid h-11 w-11 place-items-center rounded-lg border border-line-strong text-ink-soft transition-colors hover:border-accent hover:text-accent-strong ${className}`}
    >
      <span className="relative block h-[18px] w-[18px]">
        <Icon show={mounted && theme === "system"}>
          {/* half-filled circle: follow the OS */}
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 3.5v17a8.5 8.5 0 0 0 0-17Z" fill="currentColor" stroke="none" />
        </Icon>
        <Icon show={mounted && theme === "light"}>
          <circle cx="12" cy="12" r="4.2" />
          <path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4 17 7M7 17l-1.6 1.6" />
        </Icon>
        <Icon show={mounted && theme === "dark"}>
          <path d="M20 13.4A8.4 8.4 0 1 1 10.6 4a6.8 6.8 0 0 0 9.4 9.4Z" />
        </Icon>
      </span>
    </button>
  );
}

function Icon({ show, children }: { show: boolean; children: React.ReactNode }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="absolute inset-0 h-full w-full transition-[opacity,transform] duration-300"
      style={{
        opacity: show ? 1 : 0,
        transform: show ? "rotate(0) scale(1)" : "rotate(-70deg) scale(0.6)",
      }}
    >
      {children}
    </svg>
  );
}
