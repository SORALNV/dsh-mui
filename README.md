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
mui                       # daemon が無ければ起動して mui-view で attach（日常はこれ一発）
mui new ["最初の指示"]     # 新規セッション作成 + attach
mui resume [id]           # 最後に触っていたセッション（または指定id）を再開 — tmux attach 相当
mui list                  # セッション一覧
mui url                   # ブラウザ用トークン付きURL
mui start                 # daemon 起動のみ
mui status                # daemon の状態
mui stop                  # daemon 正常停止 (SIGTERM)
mui kill                  # daemon 強制停止 (SIGKILL, ポートも解放)
mui log                   # daemon ログの末尾
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

### OpenMausBot・MCPクライアントから接続

`mui mcp` は同じMac上のコアに接続する **stdio MCP** サーバーです。コアを起動・停止せず、WebのURLや認証を変更しません。ソースから使う場合は、リポジトリで `npm ci` を実行してください。

OpenMausBotの **Plugins → MCP servers → Add server** に以下を貼り付けます。`command` とスクリプトには実際の絶対パスを、`MUI_MCP_SESSIONS` にはボットに公開してよいセッションIDを指定してください（複数はカンマ区切り）。

```json
{
  "mcpServers": {
    "mui": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/dsh-mui/bin/mui.mjs", "mcp"],
      "env": { "MUI_MCP_SESSIONS": "session-your-id" }
    }
  }
}
```

既定は読み取り専用（許可セッションの一覧・実行状態・キュー件数・直近の会話）。ボットに指示送信も任せる場合だけ `env` に `"MUI_MCP_WRITE": "1"` を追加すると、`mui_send_prompt` で `queue` または `steer` を選べます。**Bot access** は対象ボットだけに絞り、会話や指示送信を任せられるクライアントで利用してください。トークンを設定に貼る必要はありません。別マシンからのMCP接続、ACP、汎用RPC転送は提供しません。

## Compaction Manager

通常推論のモデルは変えず、DSH標準の `dsh-compaction-basic` に圧縮専用ルートを設定します。初期値は `opencode-free/deepseek-v4.1-flash-free`、機能は初期状態で無効です。

```sh
npm ci
mui compaction status
mui compaction doctor                           # 実稼働プロファイル、CLI・プラグイン、モデル一覧、構成を確認
mui compaction test                             # 無料OpenCodeルートに合成テキストを送る。既存DSH会話は使わない
mui compaction set opencode-free deepseek-v4.1-flash-free
mui compaction enable
mui compaction sync                             # 起動前に適用内容を検証・再生成
mui compaction disable                          # 専用ルートだけを解除。DSH既存の圧縮は残す
mui compaction rollback                         # 直前のManager設定を復元
```

変更は **次回のMUIコア起動時**に反映されます。このコマンド群は現在のデーモンを再起動しません。`status` の `restartRequired` で反映待ちを確認できます。`/compaction status` や `/compaction set <provider> <model>` は `mui tui` からも実行できます。Webは同梱の公式DSH設定拡張を明示的に導入すると **設定 → Compaction Manager** から操作できます。既存の認証済みオーナーのみが操作でき、設定を保存しても実行中のホストは停止しません。

```sh
# Web設定画面が必要な場合だけ、リポジトリのルートで実行
npm pack ./plugins/compaction-manager
dsh plugin --profile web add "$(pwd)/mui-compaction-manager-0.1.0.tgz"
```

既存の `dsh-deep-opencode` は変更しません。未導入の場合だけ、管理者が次の固定リビジョンを明示的に導入できます。自動更新・自動インストールは行いません。現在の検証対象は DSH `0.2.2-rc.1`、OpenCode `2.4.1`、`dsh-deep-opencode` `0.1.0` です。

```sh
dsh plugin --profile web add 'github:temidayoxyz/deep-opencode#ace9f75493313e8b1b80096f377f106401b4d538'
```

- Agent Preset内の有効なエンジンと既存の `modelPolicies` に専用ルートを設定します。元のプロファイル・認証・会話は編集せず、一時ディレクトリでDSHの構成を確認してから、MUI管理の `--patch` を原子的に生成します。
- 未検証のDSHバージョンや不整合があれば、専用ルートを適用せず警告し従来設定で起動します。**従来設定の圧縮には従来のモデルが使われ得ます。** 専用ルートが適用済みでも、下記の予備ルートを明示的に許可しない限り別モデルは呼びません。
- カタログに載ることと推論可能であることは別です。無料枠、モデル廃止や容量超過はDSH／プロバイダーのエラーに従います。容量はカタログまたは公開メタデータの参考値で、取得不能時は不明です。`test` は通常推論のプローブであり、実会話の圧縮試験ではありません。
- `node --test test/compaction.test.mjs`、`npm --prefix plugins/compaction-manager test`、`node test/compaction-live.mjs --fixture` で検証できます。`node test/compaction-live.mjs` は外部の無料ルートに合成データを送る任意の実測です。いずれも実稼働セッションに接続しません。

### レート制限・利用枠切れからの復旧

圧縮の予備ルートは既定で空です。圧縮に必要な会話の一部が送られてもよい **実在する `provider/model`** を、主ルートとは別のプロバイダーから明示的に登録してください。登録した順番で最大5件です。別のルート名でも同じ利用枠を共有するプロバイダーは避けてください。

```sh
mui recovery candidates opencode-go
mui compaction fallback '<backup-provider>/<backup-model>'
mui compaction enable
mui compaction status
# 圧縮の予備ルートを全消去（次回起動から）: mui compaction fallback
```

次回のMUIコア起動後、主ルートから圧縮出力が始まる前に429・利用枠切れが返った場合だけ、許可リストから別ルートを試します。既定モデルや切り替え先は書き換えません。出力開始後のエラー、認証・容量エラー、キャンセルはそのまま返します。予備ルートもすべて制限中なら圧縮は失敗し、DSHは置換チェックポイントを書きません。有料ルートを許可リストに明示すると利用料が生じ得ます。実際に試した予備ルートは `mui log` で確認できます。DSH標準の圧縮イベントには論理上の主ルート名が残ります。

通常推論は、同じ会話で候補を確認してから選べます。カタログは接続先の候補であり、実際の残り枠は示しません。コマンドは次のモデル選択を保存するだけで、プロンプトやツールを自動再実行しません。次の送信時に圧縮が必要なら、通常の圧縮条件が適用されます。

```sh
mui recovery candidates opencode-go
mui recovery switch '<session-id>' opencode-go '<new-provider>/<new-model>'
```

`mui tui` では `/recovery candidates <limited-provider>` と `/recovery switch <limited-provider> <provider/model>` が同じ操作を行い、後者の対象は接続中の会話です。

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
