# dsh-mui — Multi UI for DeepSeek Harness

**1つのセッションコア、複数のフェイス。** ターミナルからでもブラウザからでも、同じセッションを同時に開く。

> npm パッケージ: `@sora/dsh-mui` · コマンド: `mui` / `mui-daemon` / `mui-view` / `mui-forward`

```
                 ┌─────────────────────────────┐
                 │ mui-daemon (dsh ホスト)      │
                 │  セッション所有・単一ライター  │
                 │  /api ブリッジ :3219         │
                 └──────┬───────┬───────┬──────┘
                        │       │       │
              ブラウザ   │       │       │  tailnet / トンネル
              (Web GUI) │       │       │  (mui-forward)
                        ▼       ▼       ▼
                    どこかの端末  mui-view  電話・別マシン
```

## 使い方

**`~/.local/bin` にインストール済み**（`mui` / `mui-daemon` / `mui-view` / `mui-forward` の symlink）。

```sh
mui                 # daemon が無ければ起動して mui-view で attach（日常はこれ一発）
mui list            # セッション一覧
mui url             # ブラウザ用トークン付きURL
mui stop            # daemon 停止
mui forward tailscale | cloudflared | off | status
mui --profile mui   # 前景モード（TUI + Web を1プロセスで、ターミナルを閉じたら終了）
```

以下は各ツールの直接呼び出し（`node ~/CodePlugin/mui/bin/…` でも同じ）。

### 0. インストール（手動でやる場合）

```sh
cd ~/CodePlugin/mui && npm link   # または各 bin を ~/.local/bin にリンク
```

`node >= 22`（グローバル fetch 使用、依存パッケージなし）。

### 1. デーモンを起動（セッションコア）

```sh
cd <作業したいプロジェクト>        # ここがセッションのワークスペースになる
mui-daemon start                  # ~/.dsh/mui-daemon.json に pid/port/token、ログは ~/.dsh/mui-daemon.log
```

- `~/.dsh/mui-daemon.json` に pid/port/token を保存、ログは `~/.dsh/mui-daemon.log`
- `mui-daemon status | url | stop | log`

### 2. ターミナルフェイスで attach

```sh
mui-view list                     # セッション一覧
mui-view                          # セッションを選んで attach
mui-view --session <id>           # 直指定
mui-view --new "最初の指示"        # 新規セッション + 初回プロンプト
```

- **ビジュアル**: accent = RGB(77,107,254)、dim = ANSI dim、
  ユーザー文と入力プロンプトは `  ┃ ` バー、通知は `✓ label:` / `✗ error:`、
  思考中は `⠋ Thinking (Ns)` ブレイルローダー、ブロック間は空行区切り。`NO_COLOR` 対応。

- 入力して Enter → `session/prompt`（queue モード）。デーモンがセッションを生かし続けるので、
  **`/quit` で抜けてもターンは継続し、後で attach すれば結果が見える**
- `/stop` でターン中断、`/model <provider> <model> [effort]` でモデル変更
- 他フェイス（ブラウザ等）からのメッセージ・応答もライブ表示される

### 3. ブラウザフェイス

`mui-daemon url` のトークン付きURLを開く。同じセッション一覧・同じ会話。

### 4. 外部公開（指定URLへの転送）

**Tailscale の現在の割り当て**（2026-11-16）:

| URL | 中身 | 用途 |
|---|---|---|
| `https://macstudio.tailcf365a.ts.net/` | **3080（メインGUI `dsh web`）** | いつもの全セッションにスマホ等からattach |
| `https://macstudio.tailcf365a.ts.net:8444/` | 3219（mui-daemon） | デタッチドMUIセッション |
| 8443/8448/8449 | 他アプリ | — |

- **「このセッションはすでに使用中です」が出るとき**: セッションの所有プロセス（ライター）と
  開こうとしたホストが違う。例: 443（→3080）で開くべき所を8444（→daemon）で開くと、
  daemonは3080所有のセッションをresumeできずロック衝突になる。**URLの port と
  セッションの所有者を揃えれば解消する**（単一ライター契約の正常動作）
- メインGUIのトークン付きURLは `dsh web` を起動したターミナルの起動時出力にある
  （`http://127.0.0.1:3080/?token=…` の token 部を `https://macstudio.tailcf365a.ts.net/?token=…` に流用）
- `mui-forward tailscale` は mui-daemon を443に露出する（メインGUIと併用時は上表の
  ポート割り当てに注意）。`mui-forward cloudflared` は trycloudflare のクイックトンネル
  （`--config /dev/null` 必須 — 既存の名前付きトンネル ingress が干渉するため）
- トンネルURL確定後にデーモンを `--public-url`/`--trusted-host` 付きで再起動する
  （Host/Origin フェンスが公開authorityを信頼するため。ターン中の再起動はターンを中断する）
- 認証: プロセス毎の launch token → authority別の HttpOnly signed cookie
  （`dsh-auth-<sha256(host:port)>`）。URLを知らない人は開けない

### 5. 前景モード（TUI + Web を1プロセスで）

従来型の「ターミナルを閉じたら終わる」構成:

```sh
dsh --profile mui        # dsh-TUI と Web GUI が同一セッションに同時 attach（実測済み）
```

## 検証済みの動作（2026-11-16 未明）

| 検証 | 結果 |
|---|---|
| `mui` プロファイル: TUI⇄ブラウザの同時セッション共有・双方向 | ✅ 応答まで（[スクリーンショット](../.mui-experiment/mui-web-face-proof.png)） |
| `mui-daemon` + `mui-view` + Web RPC の3者共有 | ✅ e2e (`test/e2e.mjs`) — 両フェイスのメッセージ・両応答・ターン直列化 |
| mui-view のライブ描画（他フェイス発メッセージ・スピナー・応答） | ✅ |
| tailscale 経由の公開（tailnet権威でクッキー発行→200） | ✅ |
| cloudflared 経由の公開 | ✅（`--config /dev/null` が必要） |
| 承認ルーティング: Web発ターンのエスカレーションがWeb GUIにカード表示・回答可能 | ✅（回答→ターン続行を確認） |
| dsh-TUI 側の承認パネル（合成時） | ❌ Web側が実質の承認サーフェス（要調整） |

## 既知の制限と次の一手

1. **既定モデルは `mistral/zai-glm-5-3-flash`**（2026-11-16 変更）。DeepSeek系は未契約のため、
   `agent-default-model` 行を全プロファイル（web/tui/mui）で mistral に変更済み。
   鍵は `launchctl setenv MISTRAL_API_KEY` 済みで、mui-daemon は起動時に launchd 環境から
   プロバイダ鍵を引き継ぐ。openai-codex（OAuth）も選択可。mistral 実ターン検証済み。
2. **mui-view はポーリング（1.2s）**。Gateway の WS（`/connect?interactions=answer`）に
   対応すれば承認への回答もターミナルから可能になる（v2）。
3. **プレゼンス表示**（どのフェイスがattach中か）は未実装。ホスト側プラグインで
   peer 一覧を出すのが自然。

## ファイル

- `bin/mui.mjs` — 統合ランチャー
- `bin/mui-daemon.mjs` — デタッチド起動・状態・停止
- `bin/mui-view.mjs` — ターミナルフェイス
- `bin/mui-forward.mjs` — tailscale / cloudflared 配線
- `lib/dsh-api.mjs` — /api ブリッジクライアント（token→cookie、RPC、イベント整形）
- `test/e2e.mjs` — 2フェイス同時共有のe2eテスト
- 実験の記録: [../.mui-experiment/README.md](../.mui-experiment/README.md)
