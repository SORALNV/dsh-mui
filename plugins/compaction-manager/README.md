# Compaction Manager for DSH Web

This repo-local Cordis bundle adds **Compaction Manager** to DSH Web Settings. It shows the profile, selected provider and model, enabled/applied/restart state, and the most recent matching catalog check. Refresh reads status again; it does not run diagnostics, launch any commands, or change profile or manager settings.

## Wiring

- Target runtime: DSH `0.2.2-rc.1` with the Web settings shell and Connection services. The bundle patch contributes just this plugin. The client uses the formal `settings.section` slot.
- Use a linked checkout of this directory in a disposable profile for integration testing. The host imports `../../lib/compaction.mjs` relative to the bundle, on the first valid request, and calls `manage('status', [], { profile })`. The sibling module and its dependencies stay in the MUI checkout; the plugin tarball does not include them.
- If the package is copied rather than linked, set `MUI_COMPACTION_MANAGER_MODULE` to the absolute path of a trusted manager module on the DSH **host** before launch. The file must export the same `manage` interface. Never point it at untrusted code.
- Set `MUI_COMPACTION_MANAGER_PROFILE` on the host for an explicit profile. Otherwise, the wrapper uses `DSH_PROFILE` if available, then leaves profile selection to the manager.
- Owner-only `getStatus`, `enable`, `disable`, `set`, `sync`, and `rollback` use DSH Connection’s owner-only exact route `/api/mui-compaction-manager` on the existing listener. Writes only stage manager settings for the next MUI startup. The browser cannot choose a profile, module path, command, or arbitrary CLI arguments. Diagnostics are run from the CLI or TUI; refresh reads the last result. Local paths and raw errors are not returned.

Run `npm test` for the fixture-backed host and client registration tests. No production profile changes are required to run them.
