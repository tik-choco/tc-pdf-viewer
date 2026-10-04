import assert from 'node:assert/strict';
import { AI_MESSAGES } from '../src/i18n/ai.js';
import { LLM_SETTINGS_MESSAGES } from '@tik-choco/mistai/preact';

let count = 0;
for (const catalogs of [AI_MESSAGES, LLM_SETTINGS_MESSAGES]) {
    const reference = catalogs.en;
    const keys = Object.keys(reference).sort();
    const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
    for (const locale of ['en', 'ja', 'zh-CN', 'zh-TW']) {
        assert.deepEqual(Object.keys(catalogs[locale]).sort(), keys, `${locale}: missing or orphan keys`);
        for (const key of keys) {
            assert.equal(typeof catalogs[locale][key], 'string', `${locale}.${key}`);
            assert.ok(catalogs[locale][key].trim(), `${locale}.${key}: empty`);
            assert.deepEqual(placeholders(catalogs[locale][key]), placeholders(reference[key]), `${locale}.${key}: placeholders`);
            count++;
        }
    }
}
console.log(`i18n: ${count} entries validated across en/ja/zh-CN/zh-TW`);
