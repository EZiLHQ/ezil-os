/* Pinned Code native input hooks. Session JSON owns provenance; never a global preference. */
(function () {
    'use strict';
    const KEY = 'ezilSessionEffortV1';
    const effort = v => typeof v === 'string' && /^[A-Za-z0-9._-]{1,32}$/.test(v);
    const resource = input => input._inputModelSessionResource?.toString();
    function valid(m) {
        return m && m.version === 1 && typeof m.resource === 'string' && m.resource.length > 0
            && typeof m.model === 'string' && m.model.length > 0 && effort(m.effort)
            && m.prior && typeof m.prior.present === 'boolean' && (!m.prior.present || effort(m.prior.value))
            && Object.keys(m).sort().join() === 'effort,model,prior,resource,version'
            && Object.keys(m.prior).sort().join() === (m.prior.present ? 'present,value' : 'present');
    }
    function matches(m, state) {
        return valid(m) && state?.selectedModel?.identifier === m.model
            && state.modelConfiguration?.reasoningEffort === m.effort;
    }
    function unmark(state) {
        const contrib = { ...state.contrib }; delete contrib[KEY];
        return { ...state, contrib };
    }
    function draft(input, state) {
        const m = state?.contrib?.[KEY];
        if (!m) return state;
        const out = unmark(state);
        if (matches(m, state)) {
            out.modelConfiguration = { ...state.modelConfiguration };
            if (m.prior.present) out.modelConfiguration.reasoningEffort = m.prior.value;
            else delete out.modelConfiguration.reasoningEffort;
        }
        return out;
    }
    function prepare(input, state, target) {
        input._ezilSessionEffortMarker = undefined;
        const m = state?.contrib?.[KEY];
        if (!m) return state;
        if (matches(m, state) && m.resource === target.toString() && resource(input) === m.resource) {
            input._ezilSessionEffortMarker = { ...m, prior: { ...m.prior } };
            return state;
        }
        // Copied/stale provenance never becomes a new conversation's override or default.
        const out = draft(input, state);
        if (!matches(m, state)) {
            out.modelConfiguration = { ...state.modelConfiguration }; delete out.modelConfiguration.reasoningEffort;
        }
        return out;
    }
    function annotate(input, state) {
        const m = input._ezilSessionEffortMarker;
        if (matches(m, state) && m.resource === resource(input) && m.resource === input._currentSessionKey) {
            return { ...state, contrib: { ...state.contrib, [KEY]: { ...m, prior: { ...m.prior } } } };
        }
        // Native InputModel.setState merges contrib keys: an explicit undefined tombstone
        // is necessary to remove previous provenance (JSON serialization omits it).
        return { ...state, contrib: { ...state.contrib, [KEY]: undefined } };
    }
    function restore(input, id, config) {
        const m = input._ezilSessionEffortMarker;
        const local = valid(m) && m.resource === resource(input) && m.resource === input._currentSessionKey
            && m.model === id && config?.reasoningEffort === m.effort;
        // History/session restore is not an explicit preference selection. This also
        // protects legacy/unmarked EZiL sessions; manual picker setters are untouched.
        const ezil = input.languageModelsService?.lookupLanguageModel(id)?.vendor === 'ezil';
        input.restoreModelConfiguration(id, config, !(local || ezil));
    }
    function set(input, key, id, value) {
        if (!effort(value) || input.currentModeKind !== 'agent' || resource(input) !== key
            || input._currentSessionKey !== key || input.currentLanguageModel !== id
            || !input._inputModel || typeof input._inputModel.state?.get !== 'function') return false;
        const before = input.getModelConfiguration(id) || {};
        const old = input._ezilSessionEffortMarker;
        const prior = valid(old) && old.resource === key && old.model === id && before.reasoningEffort === old.effort
            ? { ...old.prior } : effort(before.reasoningEffort) ? { present: true, value: before.reasoningEffort } : { present: false };
        input._ezilSessionEffortMarker = { version: 1, resource: key, model: id, effort: value, prior };
        input.restoreModelConfiguration(id, { ...before, reasoningEffort: value }, false);
        input.flushInputStateToModel();
        const state = input._inputModel.state.get();
        return matches(state?.contrib?.[KEY], state) && state.contrib[KEY].resource === key
            && input.getModelConfiguration(id)?.reasoningEffort === value;
    }
    return { set, draft, prepare, annotate, restore };
})()
