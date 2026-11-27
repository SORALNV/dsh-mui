window.__ModuleLoader__.load({
  id: '@mui/compaction-manager',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const namespace = 'settings.muiCompactionManager';
    async function call(action, args, signal) {
      const response = await fetch('api/mui-compaction-manager', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, args }), signal,
      });
      if (!response.ok) throw new Error('Compaction Manager unavailable');
      return response.json();
    }
    const dictionaries = {
      en: {
        title: 'Compaction Manager',
        intro: 'Manage the dedicated summary model. Changes take effect the next time the MUI core starts.',
        refresh: 'Refresh',
        loading: 'Loading compaction status…',
        unavailable: 'Compaction status is unavailable. Check the host’s manager configuration and try again.',
        profile: 'Profile', provider: 'Provider', model: 'Model',
        enabled: 'Enabled', applied: 'Applied', restart: 'Restart required',
        yes: 'Yes', no: 'No', diagnosis: 'Last catalog check', compatibility: 'Composition compatible',
        'not-running': 'DSH was not running', 'catalog-available': 'Model listed and routable',
        'model-unavailable': 'Model was not routable', unreachable: 'Catalog unreachable',
        noDiagnosis: 'No check recorded for this model.',
      },
      ja: {
        title: 'Compaction Manager',
        intro: '圧縮専用モデルを管理します。変更は MUI コアの次回起動時に反映されます。',
        refresh: '更新',
        loading: 'コンパクションの状態を読み込んでいます…',
        unavailable: 'コンパクションの状態を取得できません。ホストのマネージャー設定を確認して、もう一度お試しください。',
        profile: 'プロファイル', provider: 'プロバイダー', model: 'モデル',
        enabled: '有効', applied: '適用済み', restart: '再起動が必要',
        yes: 'はい', no: 'いいえ', diagnosis: '最後のカタログ確認', compatibility: '構成に互換性あり',
        'not-running': 'DSH は起動していませんでした', 'catalog-available': 'モデルは一覧にあり、使用可能',
        'model-unavailable': 'モデルは使用できませんでした', unreachable: 'カタログに接続できませんでした',
        noDiagnosis: 'このモデルの確認記録はありません。',
      },
      zh: {
        title: '压缩管理器',
        intro: '查看上下文压缩的当前状态。此页面不会更改 DSH 设置。',
        refresh: '刷新',
        loading: '正在加载压缩状态…',
        unavailable: '无法获取压缩状态。请检查主机上的管理器配置后重试。',
        profile: '配置文件', provider: '提供方', model: '模型',
        enabled: '已启用', applied: '已应用', restart: '需要重启',
        yes: '是', no: '否', diagnosis: '上次目录检查', compatibility: '配置组合兼容',
        'not-running': 'DSH 未运行', 'catalog-available': '模型已列出且可路由',
        'model-unavailable': '模型不可路由', unreachable: '无法连接目录',
        noDiagnosis: '此模型没有检查记录。',
      },
    };

    function Summary({ t, status }) {
      const yesNo = (value) => t(value ? 'yes' : 'no');
      const rows = [
        ['profile', status.profile], ['provider', status.provider], ['model', status.model],
        ['enabled', yesNo(status.enabled)], ['applied', yesNo(status.applied)],
        ['restart', yesNo(status.restartRequired)],
        ['Context capacity', status.lastDiagnosis?.contextWindow?.toLocaleString() ?? '—'],
      ];
      const check = status.lastDiagnosis;
      if (check) {
        if (check.compatible !== null) rows.push(['compatibility', yesNo(check.compatible)]);
        const when = check.at ? h('time', { dateTime: check.at }, new Date(check.at).toLocaleString()) : null;
        rows.push(['diagnosis', h(React.Fragment, null, t(check.connection), when && ' · ', when)]);
      } else {
        rows.push(['diagnosis', t('noDiagnosis')]);
      }
      return h('dl', null, rows.map(([label, value]) => h('div', {
        key: label,
        style: { display: 'flex', flexWrap: 'wrap', gap: '4px 16px', padding: '6px 0' },
      }, h('dt', { style: { fontWeight: 600 } }, t(label)), h('dd', {
        style: { margin: 0, overflowWrap: 'anywhere' },
      }, value))));
    }

    function Controls({ status, change, busy }) {
      const [provider, setProvider] = React.useState(status.provider);
      const [model, setModel] = React.useState(status.model);
      return h('form', { onSubmit: e => { e.preventDefault(); change('set', { provider, model }); } },
        h('label', null, 'Provider ', h('input', { value: provider, required: true, maxLength: 128, onChange: e => setProvider(e.target.value) })), ' ',
        h('label', null, 'Model ', h('input', { value: model, required: true, maxLength: 128, onChange: e => setModel(e.target.value) })), ' ',
        h('button', { disabled: busy, type: 'submit' }, 'Save route'), ' ',
        h('button', { disabled: busy, type: 'button', onClick: () => change(status.enabled ? 'disable' : 'enable') }, status.enabled ? 'Disable' : 'Enable'), ' ',
        h('button', { disabled: busy, type: 'button', onClick: () => change('rollback') }, 'Restore previous settings'));
    }

    function Panel({ t, getStatus, mutate }) {
      const [state, setState] = React.useState({ kind: 'loading' });
      const [revision, refresh] = React.useReducer((value) => value + 1, 0);
      const [busy, setBusy] = React.useState(false);
      const [failed, setFailed] = React.useState(false);
      async function change(action, args = {}) {
        setBusy(true);
        setFailed(false);
        try {
          const result = await mutate(action, args);
          if (!result?.ok) setFailed(true);
          else setState({ kind: 'ready', value: result.value });
        } catch { setFailed(true); }
        finally { setBusy(false); }
      }
      React.useEffect(() => {
        const controller = new AbortController();
        setState({ kind: 'loading' });
        (async () => {
          try {
            const response = await getStatus(controller.signal);
            if (!controller.signal.aborted) setState(response?.ok
              ? { kind: 'ready', value: response.value }
              : { kind: 'error' });
          } catch {
            if (!controller.signal.aborted) setState({ kind: 'error' });
          }
        })();
        return () => controller.abort();
      }, [getStatus, revision]);

      return h('section', { 'aria-label': t('title') },
        h('h2', null, t('title')),
        h('p', null, t('intro')),
        h('button', {
          type: 'button',
          disabled: state.kind === 'loading',
          onClick: () => refresh(),
          style: {
            font: 'inherit', color: 'inherit', background: 'transparent',
            border: '1px solid var(--dsw-alias-border-default, currentColor)',
            borderRadius: '6px', padding: '4px 12px',
          },
        }, t('refresh')),
        state.kind === 'loading' && h('p', { role: 'status' }, t('loading')),
        state.kind === 'error' && h('p', { role: 'alert' }, t('unavailable')),
        failed && h('p', { role: 'alert' }, t('unavailable')),
        state.kind === 'ready' && h(Summary, { t, status: state.value }),
        state.kind === 'ready' && h(Controls, { key: `${state.value.provider}/${state.value.model}`, status: state.value, busy, change }),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(namespace, dictionaries));
        const t = ctx.locale.bind(namespace);
        const getStatus = (signal) => call('getStatus', {}, signal);
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'mui-compaction-manager',
          order: 80,
          label: () => t('title'),
          locale: namespace,
          inject: () => ({ getStatus, mutate: call }),
        }, Panel));
      },
    };
  },
});
