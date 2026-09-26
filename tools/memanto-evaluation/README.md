# Memanto adoption evaluation — OFF

This is an unperformed optional experiment, not a deployed or tested Memanto integration. No Memanto package, daemon, credentials, model, namespace or global agent hook has been installed or configured. No `remember`, `recall`, `deleteMemory`, `answer` or `uploadFile` call has been made. There is no experiment launcher in `npm test` and no enable switch in production.

## Current decision

Keep Memanto off for 0.5. The three permitted preferences already fit a small local record; no measured retrieval benefit currently justifies another service or transfer of preference data. The actual Memanto deployment size, pinned version, backend network destinations, latency, failure behavior and retrieval value are **unknown**, because that service was not installed or exercised. Do not substitute the synthetic local authorization tests for those measurements.

The shipped implementation adds no dependency and starts no memory process. `src/assistant-memory.mjs` reads/writes only the existing queued local store. Production constructs it without a provider. Local synthetic tests may inject a `MemoryProvider.recallCandidates({namespace, query, limit})` object; they prove the application's filtering boundary, not any external product's behavior. The query is the fixed phrase `confirmed preferences`, limit is 3, and no page, answer, chat, tool definition or file is supplied. Results must match a live locally confirmed ID, profile, namespace and revision; result text never supplies a preference value. Recall failure returns no optional results. This test seam is not exposed through HTTP settings.

Confirmed values are sent only when the user includes them in an ordinary model request, to the model connection already selected for that request. They are visible in the floating coach preview. No independent memory service receives them. Room eligibility includes profile, revision and inclusion state, so previously generated answers cannot leak into later requests through an old room after preference deletion or omission. Earlier display-only chat remains visible in its original turn.

## Gates before a future authorized experiment

Obtain separate explicit permission to install and to send synthetic preference records to a memory service; ordinary model consent is not memory-service consent. Record an exact version and dependency footprint, fixed loopback endpoint, dedicated namespace and dedicated authentication. Do not inherit environment or another application's backend settings. Exercise only `remember/recall/deleteMemory` with synthetic fixtures; never `answer/uploadFile`, page-sized queries, material-tool registration or global agent hooks. Capture network destinations, recall/deletion/restart failure behavior, stale IDs, wrong profiles, expiration and actual benefit over three local enums. Keep the feature off unless those gates pass. No such permission or experiment is represented by this document.

## Local backup contract

`exportConfirmedPreferences(state, {includeConfirmedPreferences:true})` exports only confirmed live `{key,value}` pairs. Omission/false returns `undefined`; ordinary question-pack exports never include preference data. The personal-backup query `includeConfirmedPreferences=true` is the explicit opt-in API. The final backup UI option is integrated by T12.

`restorePreferencePolicy(currentState, optionalBackup)` retains the current profile and deletion tombstones, increases the current revision, and imports optional values as **unconfirmed**. Any previously deleted key is excluded from automatic restoration. Restoring without preference data clears values but retains revocation records. A user can explicitly confirm a value again; restoring a backup cannot confer that authorization. Existing attempts, recordings, original chat display and model configuration are not memory sources.
