import { l, lt } from './i18n.js';
import { getRequestHeaders } from '../../../../script.js';
import { requestJev } from './jev-retrieval.js';

const SECRET = 'api_key_living_lorebook_jev';
const TYPESAFE_SECRET = 'api_key_typesafe_jev';

export const JEV_TYPESAFE_SETTINGS = lt('ll.jev.typesafe')`<div class="ll-jev-connection ll-jev-typesafe">
    <div class="ll-jev-heading"><b>Jev</b><span class="ll-jev-provider">TypeSafe (direct)</span></div>
    <label class="ll-jev-field" for="ll_s_ts_key">
        <span>API key</span>
        <input id="ll_s_ts_key" class="text_pole" type="password" autocomplete="new-password" placeholder="Enter your TypeSafe API key" />
    </label>
    <div class="ll-jev-actions">
        <button type="button" class="menu_button" id="ll_s_ts_save"><i class="fa-solid fa-check" aria-hidden="true"></i>Save key</button>
        <button type="button" class="menu_button" id="ll_s_ts_delete">Delete</button>
    </div>
    <p>While a TypeSafe key is saved, Jev calls go straight to TypeSafe and the Vercel key below is not used.</p>
</div>`;

export const JEV_CONNECTION_SETTINGS = lt('ll.jev.connection')`<div class="ll-jev-connection">
    <div class="ll-jev-heading"><b>Jev</b><span class="ll-jev-provider">Vercel AI Gateway</span></div>
    <label class="ll-jev-field" for="ll_s_jev_key">
        <span>API key</span>
        <input id="ll_s_jev_key" class="text_pole" type="password" autocomplete="new-password" placeholder="Enter your Vercel API key" />
    </label>
    <div class="ll-jev-actions">
        <button type="button" class="menu_button" id="ll_s_jev_save"><i class="fa-solid fa-check" aria-hidden="true"></i>Save key</button>
        <button type="button" class="menu_button" id="ll_s_jev_test"><i class="fa-solid fa-plug" aria-hidden="true"></i>Test connection</button>
        <button type="button" class="menu_button" id="ll_s_jev_delete">Delete</button>
    </div>
    <div id="ll_s_jev_status" class="ll-jev-status" role="status" aria-live="polite"></div>
    <details class="ll-jev-details"><summary>Data & privacy</summary>
        <p>Jev selection sends recent conversation and active memories to Vercel and TypeSafe. Your key is stored on the SillyTavern server and excluded from presets.</p>
        <p>Connection tests send only a sample sentence. Usage charges may apply.</p>
        <label class="checkbox_label"><input id="ll_s_jev_zdr" type="checkbox" /><span>Require provider ZDR routing</span></label>
        <p>ZDR requires Vercel Pro/Enterprise. Every call requests no training; requests fail if the required ZDR routing is unavailable.</p>
    </details>
</div>`;

export const JEV_SETTINGS = lt('ll.jev.settings')`<div class="ll-settings-row ll-eng-jev" style="display:none"><label for="ll_s_jev_k">Maximum memories</label><input id="ll_s_jev_k" class="ll-settings-input" type="number" min="1" max="50" /></div>
<div class="ll-settings-row ll-eng-jev" style="display:none"><label for="ll_s_jev_threshold">Relevance threshold</label><input id="ll_s_jev_threshold" class="ll-settings-input" type="number" min="0.1" max="1" step="0.05" /><span class="ll-settings-unit">Higher values select only more relevant memories.</span></div>`;

export function jevErrorMessage(code) {
    const messages = {
        server_restart: l('ll.jev.restart', 'Restart SillyTavern to load the Jev server endpoint.'),
        missing_key: l('ll.jev.missing', 'Save a Vercel API key first.'),
        upstream_401: l('ll.jev.401', 'Vercel rejected the API key.'),
        upstream_402: l('ll.jev.402', 'Vercel requires credits or billing setup.'),
        upstream_403: l('ll.jev.403', 'Vercel denied access. Check model access and the ZDR plan requirement.'),
        upstream_429: l('ll.jev.429', 'Vercel rate limit reached. Try again later.'),
        timeout: l('ll.jev.timeout', 'Jev timed out.'),
        invalid_response: l('ll.jev.invalid', 'Jev returned an incomplete or invalid evaluation.'),
        batch_limit: l('ll.jev.limit', 'This lorebook exceeds the current per-turn batch limit.'),
        context_limit: l('ll.jev.context', 'The evaluation exceeds the context limit.'),
    };
    return messages[code] || l('ll.jev.failed', 'Jev connection failed. No provider response text was logged.');
}

export function bindJevConnection(panel, settings, save, clear) {
    const status = panel.querySelector('#ll_s_jev_status');
    if (!status) return;
    const input = panel.querySelector('#ll_s_jev_key');
    const localRequest = async (path, body) => {
        const response = await fetch(path, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
        if (response.status === 404) throw new Error('server_restart');
        if (!response.ok) throw new Error('connection_failed');
        return response.json();
    };
    const refresh = async () => {
        try {
            const data = await localRequest('/api/jev/status', {});
            const via = data.provider === 'typesafe' ? l('ll.jev.via_typesafe', 'Using TypeSafe directly') : data.provider === 'vercel' ? l('ll.jev.via_vercel', 'Using Vercel AI Gateway') : '';
            status.textContent = data.configured ? `${l('ll.jev.saved', 'Key saved · Not tested')}${via ? ` · ${via}` : ''}` : l('ll.jev.unconfigured', 'No key saved');
        } catch (error) { status.textContent = jevErrorMessage(error.message); }
    };
    const action = (id, handler) => panel.querySelector(id)?.addEventListener('click', async () => {
        const buttons = [...panel.querySelectorAll('.ll-jev-connection button')];
        buttons.forEach(b => { b.disabled = true; });
        status.textContent = l('ll.jev.working', 'Working…');
        try { await handler(); }
        catch (error) { status.textContent = jevErrorMessage(error.name === 'AbortError' ? 'timeout' : error.message); }
        finally { buttons.forEach(b => { b.disabled = false; }); }
    });
    action('#ll_s_jev_save', async () => {
        const value = input.value.trim();
        if (!value) throw new Error('missing_key');
        try { await localRequest('/api/secrets/write', { key: SECRET, value, label: 'Living Lorebook · Vercel Jev' }); }
        finally { input.value = ''; }
        clear();
        await refresh();
    });
    const tsInput = panel.querySelector('#ll_s_ts_key');
    action('#ll_s_ts_save', async () => {
        const value = tsInput?.value.trim();
        if (!value) throw new Error('missing_key');
        try { await localRequest('/api/secrets/write', { key: TYPESAFE_SECRET, value, label: 'Living Lorebook · TypeSafe Jev' }); }
        finally { tsInput.value = ''; }
        clear();
        await refresh();
    });
    action('#ll_s_ts_delete', async () => {
        const response = await fetch('/api/jev/clear-key', {
            method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ provider: 'typesafe' }),
        });
        if (!response.ok) throw new Error('connection_failed');
        if (tsInput) tsInput.value = '';
        clear(); await refresh();
    });
    action('#ll_s_jev_delete', async () => {
        const response = await fetch('/api/jev/clear-key', {
            method: 'POST', headers: getRequestHeaders(), body: '{}',
        });
        if (!response.ok) throw new Error('connection_failed');
        input.value = ''; clear(); await refresh();
    });
    action('#ll_s_jev_test', async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 16000);
        try {
            const data = await requestJev({
                state: 'The sky is overcast and rain is falling.',
                questions: { m0: { type: 'boolean', instructions: 'Is it raining?' } },
                zeroDataRetention: settings.jevZeroDataRetention === true,
            }, controller.signal);
            if (data.answers?.m0?.type !== 'boolean' || typeof data.answers.m0.probability !== 'number') throw new Error('invalid_response');
            status.textContent = lt('ll.jev.tested')`Connected. Synthetic test probability: ${Math.round(data.answers.m0.probability * 100)}%.`;
        } finally { clearTimeout(timer); }
    });
    const zdr = panel.querySelector('#ll_s_jev_zdr');
    zdr.checked = settings.jevZeroDataRetention === true;
    zdr.addEventListener('change', () => { settings.jevZeroDataRetention = zdr.checked; clear(); save(); });
    void refresh();
}

export function bindJevSettings(panel, settings, save, clear) {
    const number = (id, key, min, max, integer = false) => {
        const el = panel.querySelector(id);
        el.value = settings[key];
        el.addEventListener('change', () => {
            let value = Number(el.value);
            if (!Number.isFinite(value)) value = settings[key];
            value = Math.max(min, Math.min(max, integer ? Math.floor(value) : value));
            el.value = value; settings[key] = value; clear(); save();
        });
    };
    number('#ll_s_jev_k', 'jevSelectK', 1, 50, true);
    number('#ll_s_jev_threshold', 'jevThreshold', 0.1, 1);
}
