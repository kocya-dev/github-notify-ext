import { graphql } from '@octokit/graphql';

type WatchTargetRepo = {
  owner: string;
  name: string;
};

type Settings = {
  pat: string;
  repos: WatchTargetRepo[];
  intervalMinutes: number;
  enableNewItems: boolean;
  enableMentions: boolean;
  enableMentionThreads: boolean;
  enableAssigneeComments: boolean;
};

type RuntimeState = {
  viewerLogin: string | null;
  lastCheckedAt: string | null;
};

const DEFAULT_INTERVAL_MINUTES = 5;

let runtimeState: RuntimeState = {
  viewerLogin: null,
  lastCheckedAt: null,
};

type NotificationKind = 'new' | 'mention' | 'thread' | 'assignee';

type StoredNotification = {
  id: string; // `${kind}:${nodeId}` などで一意化
  kind: NotificationKind;
  isPullRequest: boolean;
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  detectedAt: string; // ISO8601
};
/**
 * GitHub GraphQL クライアントを生成する。
 *
 * 設定で保存された PAT を Authorization ヘッダーに設定して返す。
 * @param pat GitHub Personal Access Token
 * @returns GraphQL クライアント
 */
function createGithubClient(pat: string) {
  return graphql.defaults({
    headers: {
      authorization: `token ${pat}`,
    },
  });
}

/**
 * 設定ストレージから PAT / 監視対象リポジトリ / 各種フラグを読み込む。
 *
 * PAT またはリポジトリ一覧が未設定の場合は null を返す。
 * @returns 設定オブジェクト、または未設定時は null
 */
async function loadSettings(): Promise<Settings | null> {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      {
        pat: '',
        repos: [],
        intervalMinutes: DEFAULT_INTERVAL_MINUTES,
        enableNewItems: true,
        enableMentions: true,
        enableMentionThreads: true,
        enableAssigneeComments: true,
      },
      (items: any) => {
        if (!items.pat || !Array.isArray(items.repos)) {
          resolve(null);
          return;
        }

        const settings: Settings = {
          pat: String(items.pat),
          repos: items.repos,
          intervalMinutes: Number(items.intervalMinutes) || DEFAULT_INTERVAL_MINUTES,
          enableNewItems: Boolean(items.enableNewItems),
          enableMentions: Boolean(items.enableMentions),
          enableMentionThreads: Boolean(items.enableMentionThreads),
          enableAssigneeComments: Boolean(items.enableAssigneeComments),
        };

        resolve(settings);
      },
    );
  });
}

/**
 * 直近の監視実行時刻 (ISO8601) をストレージとランタイム状態に保存する。
 * @param iso ISO8601 形式の日時文字列
 */
async function saveLastCheckedAt(iso: string) {
  runtimeState.lastCheckedAt = iso;
  return new Promise<void>((resolve) => {
    chrome.storage.local.set({ lastCheckedAt: iso }, () => {
      resolve();
    });
  });
}

/**
 * 拡張機能アイコン上のバッジ表示を更新する。
 *
 * 0 件のときはバッジ文字列を空にして非表示にする。
 * @param count バッジに表示する未読通知数
 */
function setBadge(count: number) {
  const text = count > 0 ? String(count) : '';
  chrome.action.setBadgeText({ text });
  if (count > 0) {
    chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
  }
}

/**
 * GitHub API から `viewer.login` を取得する。
 *
 * 一度取得した値は runtimeState にキャッシュし、以降はキャッシュを返す。
 * @param client GraphQL クライアント
 * @returns ログイン中ユーザーのログイン ID
 */
async function ensureViewerLogin(client: any): Promise<string> {
  if (runtimeState.viewerLogin) {
    return runtimeState.viewerLogin as string;
  }

  const result = await client(`query GetViewer { viewer { login } }`);
  runtimeState.viewerLogin = (result as any).viewer.login;
  return runtimeState.viewerLogin as string;
}

/**
 * `search(type: ISSUE)` で利用するクエリ文字列を組み立てる。
 *
 * - 監視対象リポジトリ: `repo:owner/name` の OR 条件
 * - 条件部分: `created:>lastCheckedAt` / `mentions:viewer` / `assignee:viewer` を OR で結合
 * @param repos 監視対象リポジトリ一覧
 * @param lastCheckedAt 前回監視時刻 (ISO8601)
 * @param viewerLogin ログインユーザーの login
 * @returns GitHub search クエリ文字列
 */
function buildRepoQuery(
  repos: WatchTargetRepo[],
  lastCheckedAt: string,
  viewerLogin: string,
): string {
  const repoPart =
    repos.length === 0 ? '' : `(${repos.map((r) => `repo:${r.owner}/${r.name}`).join(' OR ')})`;

  const conditionPart = [
    `created:>${lastCheckedAt}`,
    `mentions:${viewerLogin}`,
    `assignee:${viewerLogin}`,
  ].join(' OR ');

  return `${repoPart} is:open (${conditionPart})`.trim();
}

/**
 * 監視サイクル本体。
 *
 * 1. 設定読み込み
 * 2. Issues / PR の検索
 * 3. 新規作成 / メンション / Assignee コメント / レビュースレッドコメントの検知
 * 4. 通知ストアとバッジの更新
 * 5. `lastCheckedAt` の更新
 */
async function runWatchCycle() {
  const settings = await loadSettings();
  if (!settings || !settings.pat || settings.repos.length === 0) {
    return;
  }

  const client = createGithubClient(settings.pat);

  const nowIso = new Date().toISOString();
  const lastCheckedAt = runtimeState.lastCheckedAt ?? new Date(0).toISOString();
  const viewerLogin = await ensureViewerLogin(client as any);

  const repoQuery = buildRepoQuery(settings.repos, lastCheckedAt, viewerLogin);

  const searchResult = await (client as any)(
    `
    query WatchIssuesAndPRs(
      $repoQuery: String!,
      $lastCheckedAt: DateTime!,
      $viewerLogin: String!
    ) {
      search(query: $repoQuery, type: ISSUE, first: 50) {
        issueCount
        nodes {
          ... on Issue {
            id
            number
            title
            url
            createdAt
            updatedAt
            repository {
              name
              owner { login }
            }
            author { login }
            assignees(first: 10) {
              nodes { login }
            }
            body
            comments(first: 20, orderBy: { field: UPDATED_AT, direction: DESC }) {
              nodes {
                body
                author { login }
                createdAt
                updatedAt
              }
            }
          }
          ... on PullRequest {
            id
            number
            title
            url
            createdAt
            updatedAt
            repository {
              name
              owner { login }
            }
            author { login }
            assignees(first: 10) {
              nodes { login }
            }
            body
            comments(first: 20, orderBy: { field: UPDATED_AT, direction: DESC }) {
              nodes {
                body
                author { login }
                createdAt
                updatedAt
              }
            }
          }
        }
      }
    }
    `,
    {
      repoQuery,
      lastCheckedAt,
      viewerLogin,
    },
  );

  const issuesAndPrs = (searchResult.search?.nodes ?? []) as any[];

  // 各種イベントごとに一時配列へ振り分ける
  const newItems: any[] = [];
  const mentionItems: any[] = [];
  const assigneeCommentItems: any[] = [];
  const updatedPrIds: string[] = [];

  for (const node of issuesAndPrs) {
    const isNew = new Date(node.createdAt) > new Date(lastCheckedAt);
    const hasAssigneeMe =
      (node.assignees?.nodes ?? []).some((a: any) => a.login === viewerLogin) ?? false;

    const comments = node.comments?.nodes ?? [];
    const hasNewComment =
      comments.some((c: any) => new Date(c.updatedAt) > new Date(lastCheckedAt)) ?? false;

    const textTargets = [
      node.body as string,
      ...comments.map((c: any) => (c.body as string) ?? ''),
    ];
    const mentionToken = `@${viewerLogin}`;
    const hasMention = textTargets.some((t) => t && t.includes(mentionToken)) ?? false;

    // 新規 PR / Issue
    if (settings.enableNewItems && isNew) {
      newItems.push(node);
    }
    // 本文・コメント中に自分宛メンションが含まれるもの
    if (settings.enableMentions && hasMention) {
      mentionItems.push(node);
    }
    // 自分が Assignee かつ lastCheckedAt 以降にコメント更新があるもの
    if (settings.enableAssigneeComments && hasAssigneeMe && hasNewComment) {
      assigneeCommentItems.push(node);
    }

    const isPR = node.__typename === 'PullRequest';
    if (isPR && new Date(node.updatedAt) > new Date(lastCheckedAt)) {
      updatedPrIds.push(node.id);
    }
  }

  // 自分のメンションを含む未解決レビュー スレッドへの新規コメント検知
  const mentionThreadItems: any[] = [];
  if (settings.enableMentionThreads && updatedPrIds.length > 0) {
    const reviewResult = await (client as any)(
      `
      query WatchReviewThreads(
        $prIds: [ID!]!,
        $lastCheckedAt: DateTime!,
        $viewerLogin: String!
      ) {
        nodes(ids: $prIds) {
          ... on PullRequest {
            id
            number
            url
            title
            repository {
              name
              owner { login }
            }
            reviewThreads(first: 20) {
              nodes {
                id
                isResolved
                comments(first: 20, orderBy: { field: CREATED_AT, direction: ASC }) {
                  nodes {
                    id
                    body
                    author { login }
                    createdAt
                  }
                }
              }
            }
          }
        }
      }
      `,
      {
        prIds: updatedPrIds,
        lastCheckedAt,
        viewerLogin,
      },
    );

    for (const pr of (reviewResult.nodes ?? []) as any[]) {
      const threads = pr.reviewThreads?.nodes ?? [];
      for (const thread of threads) {
        // 解決済みスレッドは対象外
        if (thread.isResolved) continue;

        const comments = thread.comments?.nodes ?? [];
        if (comments.length === 0) continue;

        const mentionToken = `@${viewerLogin}`;
        const hadMentionBefore = comments.some(
          (c: any) =>
            new Date(c.createdAt) <= new Date(lastCheckedAt) &&
            (c.body as string)?.includes(mentionToken),
        );
        const lastComment = comments[comments.length - 1];
        const lastCreatedAt = new Date(lastComment.createdAt);

        // 過去コメントに自分宛メンションが存在し、
        // かつ最後のコメントが前回監視時刻より新しければ通知対象とする
        if (hadMentionBefore && lastCreatedAt > new Date(lastCheckedAt)) {
          mentionThreadItems.push({
            pr,
            thread,
            lastComment,
          });
        }
      }
    }
  }

  // 通知一覧ストアへ反映（重複排除しつつ追加）
  const detectedAt = nowIso;
  // GraphQL ノードから StoredNotification 形式へ変換し、kind と node.id から一意 ID を生成する
  const toStored = (node: any, kind: NotificationKind): StoredNotification | null => {
    if (!node || !node.repository) return null;
    const isPullRequest = node.__typename === 'PullRequest';
    const owner = node.repository.owner?.login ?? '';
    const repo = node.repository.name ?? '';
    const number = typeof node.number === 'number' ? node.number : 0;
    const title = node.title ?? '';
    const url = node.url ?? '';
    const nodeId = node.id ?? `${owner}/${repo}#${number}`;
    const id = `${kind}:${nodeId}`;

    return {
      id,
      kind,
      isPullRequest,
      owner,
      repo,
      number,
      title,
      url,
      detectedAt,
    };
  };

  const collected: StoredNotification[] = [];

  // 新規 PR / Issue
  for (const n of newItems) {
    const s = toStored(n, 'new');
    if (s) collected.push(s);
  }
  // 本文・コメントに自分宛メンションを含むもの
  for (const n of mentionItems) {
    const s = toStored(n, 'mention');
    if (s) collected.push(s);
  }
  // 自分が Assignee のチケットへの新規コメント
  for (const n of assigneeCommentItems) {
    const s = toStored(n, 'assignee');
    if (s) collected.push(s);
  }
  // 自分のメンションを含む未解決レビュー スレッドへのコメント
  for (const t of mentionThreadItems) {
    const pr = (t as any).pr;
    const s = toStored(pr, 'thread');
    if (s) collected.push(s);
  }

  if (collected.length > 0) {
    // 既存通知と突き合わせて重複を排除しつつ追加し、
    // 追加件数分だけバッジカウントを増やす
    await new Promise<void>((resolve) => {
      chrome.storage.local.get({ notifications: [], badgeCount: 0 }, (items: any) => {
        const existing: StoredNotification[] = Array.isArray(items.notifications)
          ? items.notifications
          : [];
        const existingIds = new Set(existing.map((n) => n.id));
        const merged = existing.slice();
        let addedCount = 0;

        for (const n of collected) {
          if (!existingIds.has(n.id)) {
            merged.push(n);
            addedCount += 1;
          }
        }

        const newBadgeCount = (items.badgeCount ?? 0) + addedCount;

        chrome.storage.local.set(
          {
            notifications: merged,
            badgeCount: newBadgeCount,
          },
          () => {
            setBadge(newBadgeCount);
            resolve();
          },
        );
      });
    });
  }

  await saveLastCheckedAt(nowIso);
}

/**
 * 設定された監視間隔でアラームを再設定する。
 *
 * sync storage の設定を読み込み、`chrome.alarms` に周期アラームを登録し直す。
 */
function setupAlarms() {
  loadSettings().then((settings) => {
    const intervalMinutes = settings?.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES;

    chrome.alarms.clear('github-notify-watch', () => {
      chrome.alarms.create('github-notify-watch', {
        periodInMinutes: intervalMinutes,
      });
    });
  });
}

// 拡張機能インストール時にアラームを初期化
chrome.runtime.onInstalled.addListener(() => {
  setupAlarms();
});

// アラーム発火時に監視サイクルを実行する
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'github-notify-watch') {
    runWatchCycle().catch((err) => {
      console.error('watch cycle failed', err);
    });
  }
});
