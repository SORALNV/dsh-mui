const loaded = Symbol.for('mui.compaction-manager.test.fixture-loaded');
globalThis[loaded] = true;
export const calls = [];
export async function manage(...args) {
  calls.push(args);
  return {
    profile: 'fixture', provider: 'configured-provider', model: 'configured-model',
    enabled: true, applied: false, restartRequired: true,
    overlay: '/private/managed-overlay.yml',
    lastDiagnosis: {
      at: '2026-11-27T14:30:00.000Z',
      connection: 'catalog-available', compatibility: { ok: true, error: '/private/test' },
      credential: 'should-never-cross-the-wire',
    },
  };
}
