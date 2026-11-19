// mui-pick — full-screen session picker for mui resume
// dsh-TUI のセッション選択画面と同じ操作系: filter / status / sort / search
import { emitKeypressEvents } from 'node:readline';

const ACCENT = '\x1b[38;2;77;107;254m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const CLEAN = '\x1b[0m';

const toTs = (v) => (typeof v === 'number' ? v : v ? Date.parse(v) || 0 : 0);

function relTime(t) {
  if (!t) return '—';
  const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export async function pickInteractive({ client, daemonCwd, title = 'Resume a previous session' }) {
  const { items } = await client.listSessions();
  const sessions = items
    .filter((x) => !x.blank)
    .map((x) => ({
      id: x.sessionId,
      updatedAt: toTs(x.updatedAt),
      createdAt: toTs(x.createdAt) || toTs(x.updatedAt),
      running: Boolean(x.running),
      cwd: x.cwd ?? '',
      title: x.projections?.values?.title || x.projections?.title || x.sessionId,
      archivedLocal: false, // この画面内でアーカイブしたもの
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write('\x1b[?1049h\x1b[?25l'); // alternate screen, hide cursor

  let filter = 'all'; // 既定は全ワークスペース (Cwdへ切替可)
  let status = 'active';
  let sort = 'updated';
  let focus = 'search'; // search | filter | status | sort
  let query = '';
  let sel = 0;
  let visible = [];

  const cleanup = (result) => {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write('\x1b[?25l\x1b[?1049l'); // leave alternate screen
    process.stdin.removeListener('keypress', onKey);
    process.stdout.removeListener('resize', render);
    return result;
  };

  function applyFilter() {
    let list = sessions.slice();
    if (focus !== 'search' && query) { /* keep query applied regardless of focus */ }
    if (query) {
      const q = query.toLowerCase();
      list = list.filter((x) => x.title.toLowerCase().includes(q) || x.id.toLowerCase().includes(q) || x.cwd.toLowerCase().includes(q));
    }
    if (filter === 'cwd' && daemonCwd) list = list.filter((x) => x.cwd === daemonCwd);
    if (status === 'active') list = list.filter((x) => !x.archivedLocal);
    else if (status === 'archived') list = list.filter((x) => x.archivedLocal);
    list.sort((a, b) => (sort === 'created' ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt));
    visible = list;
    if (sel >= visible.length) sel = 0;
  }

  function drawRow(text) {
    process.stdout.write(`\x1b[K${text}\x1b[0m\r\n`);
  }

  function render() {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    process.stdout.write('\x1b[H\x1b[2J');
    drawRow(`${BOLD}${title}${RESET}`);
    drawRow('');
    const f = (k, v) => (focus === k ? `${BOLD}${ACCENT}${v}${RESET}` : v);
    drawRow(
      `Filter: ${f('filter', filter === 'cwd' ? `Cwd` : 'Cwd')} ${f('filter', filter === 'all' ? 'All' : 'All')}   ` +
        `Status: ${f('status', status === 'active' ? 'Active' : 'Active')} ${f('status', status === 'archived' ? 'Archived' : 'Archived')}   ` +
        `Sort: ${f('sort', sort === 'updated' ? 'Updated' : 'Updated')} ${f('sort', sort === 'created' ? 'Created' : 'Created')}`,
    );
    drawRow('');
    drawRow(`Type to search: ${query}${focus === 'search' ? '\x1b[7m \x1b[27m' : ''}`);
    drawRow('');
    const maxRows = Math.max(3, rows - 12);
    const err = accent(`  ${visible.length === 0 ? 'No sessions' : ''}`);
    if (visible.length === 0) drawRow(DIM + '  No sessions' + RESET);
    for (let i = 0; i < Math.min(visible.length, maxRows); i++) {
      const x = visible[i];
      const cur = i === sel;
      const dot = x.running ? `${ACCENT}●${RESET} ` : '  ';
      const nm = x.title.length > Math.max(10, cols - 30) ? x.title.slice(0, cols - 30) + '…' : x.title;
      const cw = filter === 'all' ? `  ${DIM}${(x.cwd || '~').split('/').pop()}${RESET}` : '';
      drawRow(`${cur ? `${ACCENT}>${RESET} ` : '  '}${DIM}${relTime(x.updatedAt).padStart(9)}${RESET}  ${dot}${cur ? BOLD : ''}${nm}${RESET}${cw}`);
    }
    drawRow('');
    drawRow(DIM + `enter resume   ^a archive   esc start new   ^c quit   tab focus   ←→ change   ↑↓ browse` + RESET);
    drawRow(DIM + `${sel + 1} / ${visible.length}` + RESET);
  }

  function focusNext(dir = 1) {
    const order = ['search', 'filter', 'status', 'sort'];
    focus = order[(order.indexOf(focus) + dir + order.length) % order.length];
  }

  function changeFocused(delta) {
    if (focus === 'filter') filter = filter === 'cwd' ? 'all' : 'cwd';
    else if (focus === 'status') status = status === 'active' ? 'archived' : 'active';
    else if (focus === 'sort') sort = sort === 'updated' ? 'created' : 'updated';
    else return; // search: 左右は移動しない
    applyFilter();
    render();
  }

  async function onKey(ch, key) {
    const name = key?.name;
    if (key?.ctrl && ch === 'c') return cleanup(null);
    if (name === 'escape') return cleanup('new'); // start new flow
    if (name === 'return') return cleanup(visible[sel]?.id ?? 'new');
    if (name === 'tab') { focusNext(key?.shift ? -1 : 1); return render(); }
    if (name === 'left') return changeFocused(-1);
    if (name === 'right') return changeFocused(1);
    if (name === 'up') { sel = Math.max(0, sel - 1); return render(); }
    if (name === 'down') { sel = Math.min(visible.length - 1, sel + 1); return render(); }
    if (key?.ctrl && name === 'a') {
      const x = visible[sel];
      if (!x) return;
      try {
        await client.call('workspace/archiveSession', { request: { sessionId: x.id, stopActivity: false } });
        x.archivedLocal = true;
        applyFilter();
        render();
      } catch (e) {
        /* ignore */
      }
      return;
    }
    if (name === 'backspace') { query = query.slice(0, -1); applyFilter(); return render(); }
    if (ch && !key?.ctrl && !key?.meta && ch.length === 1) { query += ch; applyFilter(); return render(); }
  }

  process.stdout.on('resize', () => { applyFilter(); render(); });
  process.stdin.on('keypress', onKey);
  applyFilter();
  render();
}

function accent(t) { return `${ACCENT}${t}${RESET}`; }
