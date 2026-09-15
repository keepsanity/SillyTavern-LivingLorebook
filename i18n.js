import { translate } from '../../../i18n.js';

/** Namespaced keys use ST's active locale; English is the fallback. */
export const l = (key, english) => translate(english, key);

/** Translate the template before interpolation, keeping user content untouched. */
export function lt(key) {
    return (strings, ...values) => {
        const english = strings.reduce((text, part, i) => text + part + (i < values.length ? '${' + i + '}' : ''), '');
        return l(key, english).replace(/\$\{(\d+)\}/g, (match, index) =>
            Number(index) < values.length ? String(values[Number(index)]) : match);
    };
}
