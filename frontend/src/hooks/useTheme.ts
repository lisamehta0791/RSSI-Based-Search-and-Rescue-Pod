import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

/** Light / dark switch, remembered in this browser. The root layout applies it before paint. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
  }, []);

  const toggle = useCallback(() => {
    setTheme((t) => {
      const next: Theme = t === "dark" ? "light" : "dark";
      document.documentElement.classList.toggle("dark", next === "dark");
      try {
        localStorage.setItem("theme", next);
      } catch {
        /* private mode — theme just won't be remembered */
      }
      return next;
    });
  }, []);

  return { theme, toggle };
}
