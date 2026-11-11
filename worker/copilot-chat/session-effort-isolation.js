/* Native session selections are context, not authority or shared preferences. */
(function () {
    'use strict';
    const KEY = 'ezilSessionEffortV1';
    const effort = v => typeof v === 'string' && /^[A-Za-z0-9._-]{1,32}$/.test(v);
    const model = v => typeof v === 'string' && /^[A-Za-z0-9_.:\/@+-]{1,256}$/.test(v);
    const resource = input => input._inputModelSessionResource?.toString();
    const clone = m => ({ version: 2, resource: m.resource, selections: m.selections.map(s => ({ ...s })) });
    function valid(m) {
        return m && m.version === 2 && typeof m.resource === 'string' && m.resource.length > 0 && m.resource.length <= 2048
            && Object.keys(m).sort().join() === 'resource,selections,version'
            && Array.isArray(m.selections) && m.selections.length <= 128
            && m.selections.every(s => s && Object.keys(s).sort().join() === 'effort,model' && model(s.model) && effort(s.effort))
            && new Set(m.selections.map(s => s.model)).size === m.selections.length;
    }
    function active(input) {
        const m = input._ezilSessionEffortMarker;
        // Native setInputModel pre-flushes the OLD bound input before rebinding.
        // The widget key may already name the next tab; provenance belongs to the bound model.
        return valid(m) && m.resource === resource(input) ? m : undefined;
    }
    function bind(input, m) {
        input._ezilSessionEffortMarker = m;
        if (input._modelConfigStore) input._modelConfigStore._ezilSessionEffortInput = input;
    }
    function selected(input, id) { return active(input)?.selections.find(s => s.model === id); }
    // Authoritative native fallback ONLY: never _preferences/_overrides or serialized marker.prior.
    function fallback(store, id) {
        const preferences = store._readBucket()[id] ?? store.languageModelsService.getModelConfiguration(id, false);
        const value = { ...store._schemaDefaults(id), ...preferences }.reasoningEffort;
        return effort(value) ? value : undefined;
    }
    function replaceEffort(config, value) {
        const out = { ...config }; delete out.reasoningEffort;
        if (value !== undefined) out.reasoningEffort = value;
        return out;
    }
    function draft(input, state) {
        const out = { ...state, contrib: { ...state.contrib } }; delete out.contrib[KEY];
        const id = state.selectedModel?.identifier;
        const selection = selected(input, id);
        if (selection && state.modelConfiguration?.reasoningEffort === selection.effort || state.contrib?.[KEY]) {
            out.modelConfiguration = replaceEffort(state.modelConfiguration, input._modelConfigStore ? fallback(input._modelConfigStore, id) : undefined);
        }
        return out;
    }
    function prepare(input, state, target) {
        const m = state?.contrib?.[KEY];
        bind(input, undefined);
        if (!m) return state;
        const id = state.selectedModel?.identifier;
        const selection = valid(m) && m.selections.find(s => s.model === id);
        if (valid(m) && m.resource === target.toString() && resource(input) === m.resource
            && (selection ? state.modelConfiguration?.reasoningEffort === selection.effort
                : state.modelConfiguration?.reasoningEffort === (input._modelConfigStore ? fallback(input._modelConfigStore, id) : undefined))) {
            bind(input, clone(m)); return state;
        }
        // Foreign/malformed/old-version payload contributes no preference, including its prior.
        return draft(input, state);
    }
    function annotate(input, state) {
        const m = active(input);
        // Explicit tombstone is required: native InputModel.setState merges contrib keys.
        return { ...state, contrib: { ...state.contrib, [KEY]: m?.selections.length ? clone(m) : undefined } };
    }
    function restore(input, id, config) {
        const local = selected(input, id);
        const ezil = input.languageModelsService?.lookupLanguageModel(id)?.vendor === 'ezil';
        input.restoreModelConfiguration(id, config, !(local || ezil));
    }
    function set(input, key, id, value) {
        if (!effort(value) || input.currentModeKind !== 'agent' || resource(input) !== key
            || input._currentSessionKey !== key || input.currentLanguageModel !== id
            || !input._inputModel || typeof input._inputModel.state?.get !== 'function') return false;
        const m = active(input) || { version: 2, resource: key, selections: [] };
        if (!selected(input, id) && m.selections.length >= 128) return false;
        m.selections = m.selections.filter(s => s.model !== id).concat({ model: id, effort: value });
        bind(input, m);
        input.restoreModelConfiguration(id, { ...(input.getModelConfiguration(id) || {}), reasoningEffort: value }, false);
        input.flushInputStateToModel();
        const state = input._inputModel.state.get(), stored = state?.contrib?.[KEY];
        return valid(stored) && stored.resource === key && stored.selections.some(s => s.model === id && s.effort === value)
            && input.getModelConfiguration(id)?.reasoningEffort === value;
    }
    function beforeApply(store, id, patch, persist) {
        const input = store._ezilSessionEffortInput;
        if (!input || !selected(input, id)) return;
        // A real explicit picker effort (even the same value) is manual intent. Other keys aren't.
        if (persist && Object.hasOwn(patch, 'reasoningEffort')) {
            const m = active(input); m.selections = m.selections.filter(s => s.model !== id);
        }
        // Clean only local preference cache; native shared storage is never cleared or rewritten here.
        const preferences = store._preferences.get(id);
        if (preferences) store._preferences.set(id, replaceEffort(preferences, fallback(store, id)));
    }
    function afterApply(store, id, config, persisted) {
        const input = store._ezilSessionEffortInput, s = input && selected(input, id);
        if (!s) return;
        const value = fallback(store, id);
        const clean = replaceEffort(store._preferences.get(id), value);
        store._preferences.set(id, clean);
        delete persisted.reasoningEffort;
        if (value !== undefined && value !== store._schemaDefaults(id).reasoningEffort) persisted.reasoningEffort = value;
        config.reasoningEffort = s.effort;
    }
    function get(store, id, config) {
        const input = store._ezilSessionEffortInput, s = input && selected(input, id);
        return s ? { ...config, reasoningEffort: s.effort } : config;
    }
    return { set, draft, prepare, annotate, restore, beforeApply, afterApply, get };
})()
