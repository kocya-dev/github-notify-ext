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

function createGithubClient(pat: string) {
  return graphql.defaults({
    headers: {
      authorization: `token ${pat}`,
    },
  });
}

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

async function saveLastCheckedAt(iso: string) {
  runtimeState.lastCheckedAt = iso;
  return new Promise<void>((resolve) => {
    chrome.storage.local.set({ lastCheckedAt: iso }, () => {
      resolve();
    });
  });
}

async function ensureViewerLogin(client: any): Promise<string> {
  if (runtimeState.viewerLogin) {
    return runtimeState.viewerLogin as string;
  }

  const result = await client(`query GetViewer { viewer { login } }`);
  runtimeState.viewerLogin = (result as any).viewer.login;
  return runtimeState.viewerLogin;
}

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

    if (settings.enableNewItems && isNew) {
      newItems.push(node);
    }
    if (settings.enableMentions && hasMention) {
      mentionItems.push(node);
    }
    if (settings.enableAssigneeComments && hasAssigneeMe && hasNewComment) {
      assigneeCommentItems.push(node);
    }

    const isPR = node.__typename === 'PullRequest';
    if (isPR && new Date(node.updatedAt) > new Date(lastCheckedAt)) {
      updatedPrIds.push(node.id);
    }
  }

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

  for (const n of newItems) {
    const s = toStored(n, 'new');
    if (s) collected.push(s);
  }
  for (const n of mentionItems) {
    const s = toStored(n, 'mention');
    if (s) collected.push(s);
  }
  for (const n of assigneeCommentItems) {
    const s = toStored(n, 'assignee');
    if (s) collected.push(s);
  }
  for (const t of mentionThreadItems) {
    const pr = (t as any).pr;
    const s = toStored(pr, 'thread');
    if (s) collected.push(s);
  }

  if (collected.length > 0) {
    await new Promise<void>((resolve) => {
      chrome.storage.local.get({ notifications: [] }, (items: any) => {
        const existing: StoredNotification[] = Array.isArray(items.notifications)
          ? items.notifications
          : [];

        const existingIds = new Set(existing.map((n) => n.id));
        const merged = existing.slice();
        for (const n of collected) {
          if (!existingIds.has(n.id)) {
            merged.push(n);
          }
        }

        chrome.storage.local.set({ notifications: merged }, () => resolve());
      });
    });
  }

  await saveLastCheckedAt(nowIso);
}

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

chrome.runtime.onInstalled.addListener(() => {
  setupAlarms();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'github-notify-watch') {
    runWatchCycle().catch((err) => {
      console.error('watch cycle failed', err);
    });
  }
});
