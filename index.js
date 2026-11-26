import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';

// ============================================================
//  Voice Clone (Fish Audio 雲端版)
//  - 純雲端：只使用 Fish Audio Reference ID，不需要本地音檔與後端插件
//  - 每個 Reference ID 就是一個「角色音色」，可直接在台詞旁指派
//  - 自動翻譯成日文、上一則／下一則、重播、本地快取（IndexedDB）
// ============================================================

const EXT_KEY = 'st_cloud_voice';
const LEGACY_KEY = 'st_voice_clone';
const DEFAULT_FISH_URL = 'https://api.fish.audio/v1/tts';
const IDB_NAME = 'st_cloud_voice_db';
const IDB_STORE = 'tts_cache';

const FISH_MODELS = [
    ['s2.1-pro-free', 's2.1-pro-free (免費)'],
    ['s2.1-pro', 's2.1-pro (付費)'],
    ['s2-pro', 's2-pro'],
    ['s1', 's1'],
    ['speech-1.6', 'speech-1.6'],
    ['speech-1.5', 'speech-1.5'],
];
const FISH_FORMATS = [['mp3', 'mp3'], ['wav', 'wav'], ['opus', 'opus']];

const DEFAULT_SETTINGS = {
    enabled: true,
    panel_open: false,
    active_tab: 'lines', // 'lines' | 'chars' | 'settings'
    fish_api_url: DEFAULT_FISH_URL,
    fish_api_key: '',
    fish_model: 's2.1-pro-free',
    fish_format: 'mp3',
    auto_play: false,
    auto_translate_ja: true,
    test_text: 'こんにちは、音声テストです。',
    voices: [],            // [{ id, name, reference_id }]
    default_voice_id: '',  // 未指派角色時使用的音色
    char_voice_map: {},    // { 角色名: voice.id }
    _migrated: false,
};

const state = {
    audio: document.createElement('audio'),
    isPlaying: false,
    stopRequested: false,
    currentPlay: null,
    selectedMesId: null,
    cachedKeys: new Set(),
    cacheReady: false,
    trCache: new Map(),
    statusText: '就緒',
    statusOk: true,
};

// ================= Generic helpers =================

/** 小型 DOM 建立工具：h('button', {class, onclick, disabled}, ...children) */
function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null) continue;
        if (k === 'class') node.className = v;
        else if (k === 'style') node.style.cssText = v;
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else if (k in node) node[k] = v;
        else node.setAttribute(k, v);
    }
    for (const c of children.flat()) {
        if (c !== null && c !== undefined && c !== false) node.append(c);
    }
    return node;
}

function select(options, value, onChange, cls = 'stvc-select') {
    return h('select', { class: cls, onchange: (e) => onChange(e.target.value) },
        ...options.map(([val, label]) => h('option', { value: val, selected: val === value }, label)));
}

function input(value, placeholder, onChange, type = 'text') {
    return h('input', {
        type,
        class: 'stvc-input',
        value: value ?? '',
        placeholder,
        onchange: (e) => onChange(e.target.value.trim()),
    });
}

function field(label, el) {
    return h('div', { class: 'stvc-field' }, h('label', {}, label), el);
}

function checkbox(text, checked, onChange) {
    return h('label', { class: 'stvc-check' },
        h('input', { type: 'checkbox', checked: Boolean(checked), onchange: (e) => onChange(e.target.checked) }),
        text);
}

function sectionTitle(text) {
    return h('div', { style: 'font-size:12px;font-weight:700;color:#93c5fd;margin:10px 0 4px' }, text);
}

function newId() {
    return `v_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function safeFileName(str) {
    return String(str).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'voice';
}

function hashStringHex(str) {
    let h1 = 0x811c9dc5;
    let h2 = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        h1 ^= c;
        h1 = Math.imul(h1, 0x01000193);
        h2 ^= (c + i);
        h2 = Math.imul(h2, 0x01000193);
    }
    return ((h1 >>> 0).toString(16).padStart(8, '0')) + ((h2 >>> 0).toString(16).padStart(8, '0'));
}

function setStatus(msg, isOk = true) {
    state.statusText = msg;
    state.statusOk = isOk;
    const el = document.getElementById('stvc_status_bar');
    if (el) {
        el.textContent = msg;
        el.className = `stvc-status ${isOk ? 'ok' : 'err'}`;
    }
}

function setBallPlaying(on) {
    document.querySelector('.stvc-ball')?.classList.toggle('playing', on);
}

// ================= Settings =================

function cloneDefault(v) {
    return typeof v === 'object' && v !== null ? JSON.parse(JSON.stringify(v)) : v;
}

function getSettings() {
    if (!extension_settings[EXT_KEY]) extension_settings[EXT_KEY] = {};
    const s = extension_settings[EXT_KEY];

    // 從舊版 st_voice_clone 搬移可用設定（API key、模型、預設 reference id）
    if (!s._migrated) {
        const old = extension_settings[LEGACY_KEY];
        if (old) {
            if (old.fish_api_key) s.fish_api_key = old.fish_api_key;
            if (old.fish_api_url) s.fish_api_url = old.fish_api_url;
            if (old.fish_model) s.fish_model = old.fish_model;
            if (old.fish_format) s.fish_format = old.fish_format;
            if (typeof old.auto_translate_ja === 'boolean') s.auto_translate_ja = old.auto_translate_ja;
            if (typeof old.auto_play === 'boolean') s.auto_play = old.auto_play;
            if (old.fish_reference_id) {
                const id = newId();
                s.voices = [{ id, name: '舊音色', reference_id: old.fish_reference_id }];
                s.default_voice_id = id;
            }
        }
        s._migrated = true;
    }

    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[k] === undefined) s[k] = cloneDefault(v);
    }
    return s;
}

function saveAndRender() {
    saveSettingsDebounced();
    renderFloatingRoot();
}

// ================= Voices (= characters) =================

function voiceById(id) {
    return getSettings().voices.find(v => v.id === id) || null;
}

/** 角色 → 音色：先看角色指派，沒有就用預設音色 */
function voiceForSpeaker(speaker) {
    const s = getSettings();
    return voiceById(s.char_voice_map[speaker]) || voiceById(s.default_voice_id) || null;
}

function voiceOptions() {
    const s = getSettings();
    return [['', '（使用預設音色）'], ...s.voices.map(v => [v.id, v.name])];
}

function addVoice(name, referenceId) {
    const s = getSettings();
    const ref = (referenceId || '').trim();
    if (!ref) {
        toastr.warning('請填入 Fish Audio Reference ID');
        return;
    }
    if (s.voices.some(v => v.reference_id === ref)) {
        toastr.info('這個 Reference ID 已經在音色庫裡了');
        return;
    }
    const voice = { id: newId(), name: (name || '').trim() || `音色 ${s.voices.length + 1}`, reference_id: ref };
    s.voices.push(voice);
    if (!s.default_voice_id) s.default_voice_id = voice.id;
    saveAndRender();
}

function removeVoice(id) {
    const s = getSettings();
    s.voices = s.voices.filter(v => v.id !== id);
    for (const [speaker, vid] of Object.entries(s.char_voice_map)) {
        if (vid === id) delete s.char_voice_map[speaker];
    }
    if (s.default_voice_id === id) s.default_voice_id = s.voices[0]?.id || '';
    saveAndRender();
}

function setSpeakerVoice(speaker, voiceId) {
    const s = getSettings();
    if (voiceId) s.char_voice_map[speaker] = voiceId;
    else delete s.char_voice_map[speaker];
    saveAndRender();
}

function defaultVoiceName() {
    return voiceById(getSettings().default_voice_id)?.name || '未設定';
}

// ================= IndexedDB cache =================

let dbPromise = null;

function openDb() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(IDB_NAME, 1);
            req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE, { keyPath: 'key' });
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
    return dbPromise;
}

async function idbRun(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, mode);
        const req = fn(tx.objectStore(IDB_STORE));
        tx.oncomplete = () => resolve(req?.result);
        tx.onerror = () => reject(tx.error);
    });
}

const cacheGet = (key) => idbRun('readonly', (st) => st.get(key));
const cachePut = (rec) => idbRun('readwrite', (st) => st.put(rec));
const cacheKeys = () => idbRun('readonly', (st) => st.getAllKeys());
const cacheClear = () => idbRun('readwrite', (st) => st.clear());

async function refreshCacheIndex() {
    const keys = await cacheKeys();
    state.cachedKeys = new Set(keys);
}

function lineCacheKey(voice, text, s) {
    const raw = `${s.fish_model}|${s.fish_format}|${voice.reference_id}|${s.auto_translate_ja ? 'ja' : 'orig'}|${text}`;
    return `line_${hashStringHex(raw)}`;
}

// ================= Translation (free Google endpoint) =================

async function translateToJa(text) {
    if (state.trCache.has(text)) return state.trCache.get(text);
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ja&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`翻譯 HTTP ${res.status}`);
    const data = await res.json();
    const out = Array.isArray(data?.[0])
        ? data[0].map(seg => seg?.[0] || '').join('').trim()
        : '';
    const result = out || text;
    state.trCache.set(text, result);
    return result;
}

// ================= Fish Audio generation =================

async function generateSpeech(text, voice) {
    const s = getSettings();
    if (!s.fish_api_key) throw new Error('請先在「語音庫 & 設定」填入 Fish Audio API Key');

    const res = await fetch(s.fish_api_url || DEFAULT_FISH_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${s.fish_api_key}`,
            model: s.fish_model || 's2.1-pro-free',
        },
        body: JSON.stringify({
            text,
            reference_id: voice.reference_id,
            format: s.fish_format || 'mp3',
            latency: 'normal',
        }),
    });
    if (!res.ok) {
        const detail = (await res.text()).slice(0, 200);
        throw new Error(`Fish Audio HTTP ${res.status}: ${detail}`);
    }
    return res.blob();
}

/** 先查快取；沒有（或強制重配）才翻譯＋生成，並存入本地快取 */
async function fetchOrCacheLine(item, voice, force = false) {
    const s = getSettings();
    const key = lineCacheKey(voice, item.text, s);

    if (!force) {
        const rec = await cacheGet(key);
        if (rec?.blob) {
            return { blob: rec.blob, fileName: rec.fileName, fromCache: true };
        }
    }

    const text = s.auto_translate_ja
        ? await translateToJa(item.text).catch(() => item.text)
        : item.text;

    const blob = await generateSpeech(text, voice);
    const fileName = `${safeFileName(item.speaker)}_${key.slice(5, 13)}.${s.fish_format || 'mp3'}`;
    await cachePut({
        key,
        fileName,
        blob,
        speaker: item.speaker,
        voiceName: voice.name,
        createdAt: Date.now(),
    });
    state.cachedKeys.add(key);
    return { blob, fileName, fromCache: false };
}

// ================= Playback =================

function stopPlayback() {
    state.stopRequested = true;
    state.isPlaying = false;
    state.audio.pause();
    state.audio.currentTime = 0;
    state.currentPlay?.resolve();   // 讓等待中的連播流程結束
    state.currentPlay = null;
    setBallPlaying(false);
}

function playBlob(blob) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const done = () => {
            URL.revokeObjectURL(url);
            state.currentPlay = null;
            resolve();
        };
        state.audio.onended = done;
        state.audio.onerror = () => {
            URL.revokeObjectURL(url);
            state.currentPlay = null;
            reject(new Error('音訊播放失敗'));
        };
        state.currentPlay = { resolve: done };
        state.audio.src = url;
        state.audio.play().catch((err) => {
            URL.revokeObjectURL(url);
            state.currentPlay = null;
            reject(err?.name === 'NotAllowedError'
                ? new Error('瀏覽器阻擋自動播放，請手動點擊重播')
                : err);
        });
    });
}

async function playSingleLine(item, btn = null, force = false) {
    const voice = voiceForSpeaker(item.speaker);
    if (!voice) {
        toastr.warning(`「${item.speaker}」尚未指派音色，請先到「角色指派」分頁選擇`);
        return;
    }

    stopPlayback();
    state.stopRequested = false;
    state.isPlaying = true;
    setBallPlaying(true);
    if (btn) {
        btn.disabled = true;
        btn.textContent = force ? '⏳ 生成中' : '⏳ 載入中';
    }

    try {
        setStatus(force ? `正在重新生成 ${item.speaker} 的語音...` : `正在載入 ${item.speaker} 的語音...`, true);
        const { blob, fileName, fromCache } = await fetchOrCacheLine(item, voice, force);
        if (state.stopRequested) return;
        setStatus(`${fromCache ? '已重播快取' : '已生成並快取'}：${fileName}`, true);
        await playBlob(blob);
    } catch (err) {
        if (!state.stopRequested) {
            setStatus(`生成失敗: ${err.message}`, false);
            toastr.error(err.message, `${item.speaker} 語音生成失敗`);
        }
    } finally {
        state.isPlaying = false;
        setBallPlaying(false);
        renderFloatingRoot();
    }
}

async function playAllLines(lines) {
    if (!lines || lines.length === 0) return;

    const playable = lines
        .map(item => {
            const voice = voiceForSpeaker(item.speaker);
            return voice ? { ...item, voice } : null;
        })
        .filter(Boolean);

    if (playable.length === 0) {
        toastr.warning('尚未幫登場角色指派音色，請在「台詞配音」或「角色指派」設定');
        return;
    }

    stopPlayback();
    state.stopRequested = false;
    state.isPlaying = true;
    setBallPlaying(true);

    const prefetch = (item) => {
        const p = fetchOrCacheLine(item, item.voice, false);
        p.catch(() => {}); // 避免被中斷時出現未處理的 rejection
        return p;
    };

    const n = playable.length;
    try {
        let next = prefetch(playable[0]);
        for (let i = 0; i < n; i++) {
            if (state.stopRequested) break;
            setStatus(`處理中 [${i + 1}/${n}] ${playable[i].speaker}...`, true);
            const { blob, fileName, fromCache } = await next;
            if (state.stopRequested) break;

            if (i + 1 < n) next = prefetch(playable[i + 1]);

            setStatus(`播放 [${i + 1}/${n}] ${playable[i].speaker} (${fromCache ? '快取' : '新生成'}: ${fileName})`, true);
            await playBlob(blob);
        }
        if (!state.stopRequested) setStatus(`連播完成（共 ${n} 句）`, true);
    } catch (err) {
        if (!state.stopRequested) {
            setStatus(`播放錯誤: ${err.message}`, false);
            toastr.error(err.message, '語音播放錯誤');
        }
    } finally {
        state.isPlaying = false;
        setBallPlaying(false);
        renderFloatingRoot();
    }
}

async function previewVoice(voice, btn) {
    const s = getSettings();
    stopPlayback();
    state.stopRequested = false;
    state.isPlaying = true;
    setBallPlaying(true);
    if (btn) btn.disabled = true;
    try {
        setStatus(`正在試聽「${voice.name}」...`, true);
        const { blob, fromCache } = await fetchOrCacheLine({ speaker: voice.name, text: s.test_text }, voice, false);
        setStatus(`試聽${fromCache ? '（快取）' : ''}：${voice.name}`, true);
        await playBlob(blob);
    } catch (err) {
        setStatus(`試聽失敗: ${err.message}`, false);
        toastr.error(err.message, '試聽失敗');
    } finally {
        state.isPlaying = false;
        setBallPlaying(false);
        if (btn) btn.disabled = false;
    }
}

// ================= Dialogue parsing =================

function extractDialogueLines(rawText) {
    if (!rawText) return [];
    const lines = [];
    const tagRegex = /【([^】/\n]+)】([\s\S]*?)【\/\1】/g;
    let match;
    while ((match = tagRegex.exec(rawText)) !== null) {
        const speaker = match[1].trim();
        const text = match[2].replace(/<[^>]+>/g, '').trim();
        if (speaker && text) lines.push({ speaker, text });
    }
    return lines;
}

function discoverSpeakers() {
    const s = getSettings();
    const ctx = getContext();
    const set = new Set(Object.keys(s.char_voice_map));
    for (const msg of ctx?.chat || []) {
        if (!msg?.mes) continue;
        for (const item of extractDialogueLines(msg.mes)) set.add(item.speaker);
    }
    return Array.from(set);
}

function getAllDialogueMessages() {
    const chat = getContext()?.chat || [];
    const list = [];
    for (let i = 0; i < chat.length; i++) {
        const msg = chat[i];
        if (!msg || msg.is_user || !msg.mes) continue;
        const lines = extractDialogueLines(msg.mes);
        if (lines.length > 0) list.push({ mesId: i, lines });
    }
    return list;
}

function getLatestDialogueMessage() {
    const all = getAllDialogueMessages();
    return all.length > 0 ? all[all.length - 1] : null;
}

function getSelectedDialogueEntry() {
    const all = getAllDialogueMessages();
    if (all.length === 0) return { all, currentIndex: -1, entry: null };
    if (state.selectedMesId !== null) {
        const idx = all.findIndex(item => item.mesId === state.selectedMesId);
        if (idx !== -1) return { all, currentIndex: idx, entry: all[idx] };
    }
    return { all, currentIndex: all.length - 1, entry: all[all.length - 1] };
}

// ================= UI: 台詞配音 =================

function buildLinesTab(body) {
    const s = getSettings();
    const { all, currentIndex, entry } = getSelectedDialogueEntry();
    const lines = entry?.lines || [];

    if (!state.cacheReady) {
        state.cacheReady = true;
        refreshCacheIndex().then(() => {
            if (getSettings().panel_open && getSettings().active_tab === 'lines') renderFloatingRoot();
        }).catch(() => {});
    }

    if (all.length > 0) {
        body.appendChild(h('div', { class: 'stvc-row', style: 'justify-content:space-between' },
            h('button', {
                type: 'button', class: 'stvc-btn', disabled: currentIndex <= 0,
                onclick: () => {
                    state.selectedMesId = all[currentIndex - 1].mesId;
                    renderFloatingRoot();
                },
            }, '◀ 上一則'),
            h('span', { style: 'font-size:12px;color:#cbd5e1' },
                `第 ${currentIndex + 1} / ${all.length} 回 (訊息 #${entry.mesId})`),
            h('button', {
                type: 'button', class: 'stvc-btn', disabled: currentIndex >= all.length - 1,
                onclick: () => {
                    const nextIdx = currentIndex + 1;
                    state.selectedMesId = nextIdx === all.length - 1 ? null : all[nextIdx].mesId;
                    renderFloatingRoot();
                },
            }, '下一則 ▶'),
        ));
    }

    body.appendChild(h('div', { class: 'stvc-row', style: 'justify-content:space-between' },
        checkbox('新訊息自動配音', s.auto_play, (v) => { s.auto_play = v; saveSettingsDebounced(); }),
        h('div', { class: 'stvc-row' },
            h('button', { type: 'button', class: 'stvc-btn primary', onclick: () => playAllLines(lines) }, '▶ 全部連播'),
            h('button', { type: 'button', class: 'stvc-btn', onclick: () => stopPlayback() }, '⏹ 停止'),
        ),
    ));

    if (lines.length === 0) {
        body.appendChild(h('div', { class: 'stvc-empty' }, '目前最新回覆中沒有偵測到【角色名】台詞【/角色名】'));
        return;
    }

    const list = h('div', { class: 'stvc-list' });
    lines.forEach((item, idx) => {
        const voice = voiceForSpeaker(item.speaker);
        const cached = voice ? state.cachedKeys.has(lineCacheKey(voice, item.text, s)) : false;

        const assignSel = select(
            voiceOptions(),
            s.char_voice_map[item.speaker] || '',
            (val) => setSpeakerVoice(item.speaker, val),
        );

        const actions = cached
            ? [
                h('button', {
                    type: 'button', class: 'stvc-btn primary',
                    onclick: (e) => playSingleLine(item, e.currentTarget, false),
                }, '▶ 重播'),
                h('button', {
                    type: 'button', class: 'stvc-btn',
                    onclick: (e) => playSingleLine(item, e.currentTarget, true),
                }, '🔄 重配'),
            ]
            : [
                h('button', {
                    type: 'button', class: 'stvc-btn',
                    onclick: (e) => playSingleLine(item, e.currentTarget, true),
                }, '🔊 生成'),
            ];

        list.appendChild(h('div', { class: 'stvc-line-card' },
            h('div', { class: 'stvc-line-content' },
                h('div', { class: 'stvc-line-speaker' }, `${idx + 1}. ${item.speaker}`),
                h('div', { class: 'stvc-line-text' }, item.text),
                assignSel,
                cached ? h('div', { class: 'stvc-cache-badge' }, '💾 已快取') : null,
            ),
            h('div', { class: 'stvc-line-actions' }, ...actions),
        ));
    });
    body.appendChild(list);
}

// ================= UI: 角色指派 =================

function buildCharsTab(body) {
    const nameIn = h('input', { class: 'stvc-input', placeholder: '手動新增角色名稱（例：丰川祥子）' });
    body.appendChild(h('div', { class: 'stvc-row' },
        nameIn,
        h('button', {
            type: 'button', class: 'stvc-btn',
            onclick: () => {
                const name = nameIn.value.trim();
                if (!name) return;
                if (!(name in getSettings().char_voice_map)) setSpeakerVoice(name, '');
                else renderFloatingRoot();
            },
        }, '新增'),
    ));

    body.appendChild(h('div', { style: 'font-size:12px;color:#94a3b8;margin:6px 0' },
        '每個角色從音色庫選一個音色；沒指派的角色會使用預設音色。'));

    const names = discoverSpeakers();
    if (names.length === 0) {
        body.appendChild(h('div', { class: 'stvc-empty' }, '對話中還沒有偵測到角色，也可以手動新增'));
        return;
    }

    const s = getSettings();
    const list = h('div', { class: 'stvc-list' });
    for (const name of names) {
        list.appendChild(h('div', { class: 'stvc-char-row' },
            h('span', { class: 'stvc-char-name', title: name }, name),
            select(voiceOptions(), s.char_voice_map[name] || '', (v) => setSpeakerVoice(name, v)),
            h('button', { type: 'button', class: 'stvc-btn', title: '清除指派', onclick: () => setSpeakerVoice(name, '') }, '✕'),
        ));
    }
    body.appendChild(list);
}

// ================= UI: 語音庫 & 設定 =================

function voiceRow(v) {
    const s = getSettings();
    const isDefault = s.default_voice_id === v.id;
    return h('div', { class: 'stvc-char-row' },
        h('input', {
            class: 'stvc-input',
            value: v.name,
            onchange: (e) => {
                v.name = e.target.value.trim() || v.name;
                saveAndRender();
            },
        }),
        h('span', { class: 'stvc-char-name', title: v.reference_id }, `${v.reference_id.slice(0, 10)}…`),
        h('button', {
            type: 'button', class: 'stvc-btn', title: '試聽',
            onclick: (e) => previewVoice(v, e.currentTarget),
        }, '▶'),
        h('button', {
            type: 'button', class: isDefault ? 'stvc-btn primary' : 'stvc-btn', title: '設為預設音色',
            onclick: () => {
                s.default_voice_id = v.id;
                saveAndRender();
            },
        }, '★'),
        h('button', { type: 'button', class: 'stvc-btn', title: '刪除', onclick: () => removeVoice(v.id) }, '✕'),
    );
}

function buildSettingsTab(body) {
    const s = getSettings();

    body.appendChild(sectionTitle('Fish Audio 雲端 API'));
    body.appendChild(field('API URL:', input(s.fish_api_url, DEFAULT_FISH_URL, (v) => {
        s.fish_api_url = v || DEFAULT_FISH_URL;
        saveSettingsDebounced();
    })));
    body.appendChild(field('API Key:', input(s.fish_api_key, '填入 Fish Audio API Key', (v) => {
        s.fish_api_key = v;
        saveSettingsDebounced();
    }, 'password')));
    body.appendChild(h('div', { class: 'stvc-grid' },
        field('Model:', select(FISH_MODELS, s.fish_model, (v) => { s.fish_model = v; saveAndRender(); })),
        field('輸出格式:', select(FISH_FORMATS, s.fish_format, (v) => { s.fish_format = v; saveAndRender(); })),
    ));
    body.appendChild(checkbox('自動將台詞翻譯成日文後再生成', s.auto_translate_ja, (v) => {
        s.auto_translate_ja = v;
        saveSettingsDebounced();
    }));
    body.appendChild(field('試聽文字:', input(s.test_text, '', (v) => {
        s.test_text = v;
        saveSettingsDebounced();
    })));

    body.appendChild(sectionTitle('音色庫（每個 Reference ID = 一個角色音色）'));
    const nameIn = h('input', { class: 'stvc-input', placeholder: '角色名稱（例：丰川祥子）' });
    const refIn = h('input', { class: 'stvc-input', placeholder: 'Fish Audio Reference ID' });
    body.appendChild(h('div', { class: 'stvc-row' },
        nameIn,
        refIn,
        h('button', { type: 'button', class: 'stvc-btn primary', onclick: () => addVoice(nameIn.value, refIn.value) }, '新增'),
    ));

    if (s.voices.length === 0) {
        body.appendChild(h('div', { class: 'stvc-empty' }, '尚未新增音色，請貼上 Fish Audio 的 Reference ID'));
    } else {
        for (const v of s.voices) body.appendChild(voiceRow(v));
    }

    body.appendChild(h('div', { class: 'stvc-row', style: 'justify-content:flex-end;margin-top:8px' },
        h('button', {
            type: 'button', class: 'stvc-btn',
            onclick: async () => {
                try {
                    await cacheClear();
                    state.cachedKeys = new Set();
                    toastr.success('已清除本地快取');
                    renderFloatingRoot();
                } catch (err) {
                    toastr.error(err.message, '清除快取失敗');
                }
            },
        }, '🗑 清除本地快取'),
    ));
}

// ================= Floating root =================

function renderFloatingRoot() {
    const s = getSettings();
    let root = document.getElementById('stvc_root');
    if (!s.enabled) {
        root?.remove();
        return;
    }
    if (!root) {
        root = document.createElement('div');
        root.id = 'stvc_root';
        document.body.appendChild(root);
    }
    root.innerHTML = '';

    if (s.panel_open) {
        const panel = h('div', { class: 'stvc-panel' });

        panel.appendChild(h('div', { class: 'stvc-panel-header' },
            h('span', { class: 'stvc-panel-title' }, '🎙️ Voice Clone 控制台'),
            h('button', {
                type: 'button', class: 'stvc-btn',
                onclick: () => {
                    s.panel_open = false;
                    saveAndRender();
                },
            }, '收起'),
        ));

        const tabDefs = [
            ['lines', '台詞配音'],
            ['chars', '角色指派'],
            ['settings', '語音庫 & 設定'],
        ];
        panel.appendChild(h('div', { class: 'stvc-tabs' },
            ...tabDefs.map(([id, label]) => h('button', {
                type: 'button',
                class: `stvc-tab ${s.active_tab === id ? 'active' : ''}`,
                onclick: () => {
                    s.active_tab = id;
                    saveAndRender();
                },
            }, label)),
        ));

        const body = h('div', { class: 'stvc-body' });
        if (s.active_tab === 'lines') buildLinesTab(body);
        else if (s.active_tab === 'chars') buildCharsTab(body);
        else buildSettingsTab(body);
        panel.appendChild(body);

        panel.appendChild(h('div', {
            id: 'stvc_status_bar',
            class: `stvc-status ${state.statusOk ? 'ok' : 'err'}`,
        }, state.statusText));

        root.appendChild(panel);
    }

    const latest = getLatestDialogueMessage();
    const count = latest?.lines?.length || 0;
    root.appendChild(h('button', {
        type: 'button',
        class: `stvc-ball ${state.isPlaying ? 'playing' : ''}`,
        onclick: () => {
            s.panel_open = !s.panel_open;
            saveAndRender();
        },
    }, s.panel_open ? '🎙️ 收起面板' : `🎙️ 語音配音${count > 0 ? ` (${count})` : ''}`));
}

// ================= Extension drawer (Extensions tab) =================

function mountExtensionDrawer() {
    const container = $('#extensions_settings2');
    if (!container.length || $('#stvc_ext_drawer').length) return;

    const s = getSettings();
    const html = `
    <div id="stvc_ext_drawer" class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Voice Clone (Fish Audio 雲端)</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content stvc-ext-drawer">
            <label class="checkbox_label" for="stvc_ext_enabled">
                <input id="stvc_ext_enabled" type="checkbox" />
                <span>啟用 Voice Clone 懸浮球</span>
            </label>
            <button id="stvc_ext_toggle_panel" type="button" class="menu_button">
                展開／收起懸浮面板
            </button>
        </div>
    </div>`;
    container.append(html);

    $('#stvc_ext_enabled')
        .prop('checked', Boolean(s.enabled))
        .on('change', function () {
            s.enabled = $(this).prop('checked');
            saveAndRender();
        });

    $('#stvc_ext_toggle_panel').on('click', () => {
        if (!s.enabled) {
            s.enabled = true;
            $('#stvc_ext_enabled').prop('checked', true);
        }
        s.panel_open = !s.panel_open;
        saveAndRender();
    });
}

// ================= Boot =================

jQuery(async () => {
    mountExtensionDrawer();
    const s = getSettings();
    if (s.enabled) renderFloatingRoot();

    eventSource.on(event_types.CHAT_CHANGED, () => {
        state.selectedMesId = null;
        setTimeout(renderFloatingRoot, 200);
    });

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (mesId) => {
        state.selectedMesId = null;
        renderFloatingRoot();
        const cur = getSettings();
        if (cur.enabled && cur.auto_play) {
            const msg = getContext()?.chat?.[mesId];
            const lines = msg?.mes ? extractDialogueLines(msg.mes) : [];
            if (lines.length > 0) playAllLines(lines);
        }
    });
});
