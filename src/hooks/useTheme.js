import { useState, useEffect, useCallback } from 'preact/hooks';

const STORAGE_KEY = 'tc-pdf-theme';
const THEME_COLORS = { light: '#f5f6f8', dark: '#0b0c10' };

export function getStoredTheme() {
    try {
        const t = localStorage.getItem(STORAGE_KEY);
        if (t === 'dark' || t === 'light') return t;
    } catch (e) {
        /* localStorage unavailable (private mode etc.) */
    }
    return 'light';
}

export function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_COLORS[theme] || THEME_COLORS.light);
}

/**
 * Light/dark theme with localStorage persistence. Light is the default.
 * The initial theme is also applied by an inline script in index.html to
 * avoid a flash of the wrong theme before hydration; this hook keeps the
 * document, storage, and UI in sync afterwards.
 */
export function useTheme() {
    const [theme, setThemeState] = useState(getStoredTheme);

    useEffect(() => {
        applyTheme(theme);
        try {
            localStorage.setItem(STORAGE_KEY, theme);
        } catch (e) {
            /* ignore persistence failures */
        }
    }, [theme]);

    const toggleTheme = useCallback(() => {
        setThemeState((t) => (t === 'dark' ? 'light' : 'dark'));
    }, []);

    return { theme, toggleTheme };
}
