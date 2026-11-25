import de from './i18n/de.json';
import en from './i18n/en.json';

const catalogs: Record<string, Record<string, string>> = {
    de: de as Record<string, string>,
    en: en as Record<string, string>,
};

export function tr(lang: string | undefined, key: string, ...args: Array<string | number>): string {
    const cat = catalogs[String(lang || 'en').slice(0, 2)] || catalogs.en;
    let s = cat[key] || catalogs.en[key] || key;
    for (const a of args) {
        s = s.replace('%s', String(a));
    }
    return s;
}
