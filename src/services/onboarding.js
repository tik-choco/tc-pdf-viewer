const DONE_KEY = 'tc-pdf-onboarding-done';

export function isOnboardingDone() {
    try {
        return localStorage.getItem(DONE_KEY) === '1';
    } catch {
        return true; // storage不可時は完了扱いでループ防止
    }
}

export function markOnboardingDone() {
    try {
        localStorage.setItem(DONE_KEY, '1');
    } catch {
        /* noop */
    }
}

export function shouldShowOnboarding() {
    if (isOnboardingDone()) return false;

    // 既存ユーザー(すでにPDFを持っている)は黙って完了扱いにして邪魔しない
    try {
        const raw = localStorage.getItem('mist_files_index');
        if (raw) {
            const idx = JSON.parse(raw);
            const count = Array.isArray(idx) ? idx.length : Object.keys(idx || {}).length;
            if (count > 0) {
                markOnboardingDone();
                return false;
            }
        }
    } catch {
        /* 判定不能なら表示側に倒す */
    }

    return true;
}

// 再表示チャネル(設定画面 -> Appシェル、同一タブpub/sub)
const listeners = new Set();

export function subscribeOnboardingRequests(listener) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function requestOnboarding() {
    for (const listener of listeners) {
        try {
            listener();
        } catch (e) {
            console.warn('onboarding listener threw', e);
        }
    }
}
