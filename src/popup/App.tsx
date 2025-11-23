import React, { useEffect, useState } from 'react';

type NotificationKind = 'new' | 'mention' | 'thread' | 'assignee';

type StoredNotification = {
  id: string;
  kind: NotificationKind;
  isPullRequest: boolean;
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  detectedAt: string;
};

type GroupedNotifications = {
  prs: StoredNotification[];
  issues: StoredNotification[];
};

type PopupSettings = {
  enableNewItems: boolean;
  enableMentions: boolean;
  enableMentionThreads: boolean;
  enableAssigneeComments: boolean;
};

function groupByType(items: StoredNotification[]): GroupedNotifications {
  const prs: StoredNotification[] = [];
  const issues: StoredNotification[] = [];

  for (const n of items) {
    if (n.isPullRequest) {
      prs.push(n);
    } else {
      issues.push(n);
    }
  }

  const byDetectedDesc = (a: StoredNotification, b: StoredNotification) =>
    new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime();

  prs.sort(byDetectedDesc);
  issues.sort(byDetectedDesc);

  return { prs, issues };
}

function formatKind(kind: NotificationKind): string {
  switch (kind) {
    case 'new':
      return '新規';
    case 'mention':
      return 'メンション';
    case 'thread':
      return 'スレッド';
    case 'assignee':
      return '担当';
    default:
      return kind;
  }
}

const App: React.FC = () => {
  const [notifications, setNotifications] = useState<StoredNotification[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [settings, setSettings] = useState<PopupSettings | null>(null);

  useEffect(() => {
    chrome.storage.local.get({ notifications: [] }, (items) => {
      const list = Array.isArray(items.notifications)
        ? (items.notifications as StoredNotification[])
        : [];
      setNotifications(list);
      setIsLoading(false);
    });
    chrome.storage.sync.get(
      {
        enableNewItems: true,
        enableMentions: true,
        enableMentionThreads: true,
        enableAssigneeComments: true,
      },
      (items) => {
        setSettings({
          enableNewItems: Boolean(items.enableNewItems),
          enableMentions: Boolean(items.enableMentions),
          enableMentionThreads: Boolean(items.enableMentionThreads),
          enableAssigneeComments: Boolean(items.enableAssigneeComments),
        });
      },
    );
  }, []);

  const handleOpen = (n: StoredNotification) => {
    if (n.url) {
      chrome.tabs.create({ url: n.url });
    }
    // 既読処理やバッジ減算は別タスクで実装予定
  };

  const isKindEnabled = (kind: NotificationKind): boolean => {
    if (!settings) return true;
    switch (kind) {
      case 'new':
        return settings.enableNewItems;
      case 'mention':
        return settings.enableMentions;
      case 'thread':
        return settings.enableMentionThreads;
      case 'assignee':
        return settings.enableAssigneeComments;
      default:
        return true;
    }
  };

  const visibleNotifications = notifications.filter((n) => isKindEnabled(n.kind));
  const { prs, issues } = groupByType(visibleNotifications);

  return (
    <div
      style={{
        width: '360px',
        padding: '10px',
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        fontSize: '12px',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '8px',
        }}
      >
        <h1 style={{ fontSize: '14px', margin: 0 }}>GitHub Notify</h1>
      </header>

      {isLoading ? (
        <p style={{ margin: 0 }}>読み込み中...</p>
      ) : visibleNotifications.length === 0 ? (
        <p style={{ margin: 0 }}>現在表示できる通知はありません。</p>
      ) : (
        <div style={{ maxHeight: '480px', overflowY: 'auto' }}>
          {prs.length > 0 && (
            <section style={{ marginBottom: '8px' }}>
              <h2
                style={{
                  fontSize: '12px',
                  fontWeight: 600,
                  margin: '4px 0',
                  borderBottom: '1px solid #ddd',
                  paddingBottom: '2px',
                }}
              >
                Pull Requests
              </h2>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {prs.map((n) => (
                  <li
                    key={n.id}
                    style={{
                      padding: '4px 0',
                      borderBottom: '1px solid #eee',
                      cursor: 'pointer',
                    }}
                    onClick={() => handleOpen(n)}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        marginBottom: '2px',
                      }}
                    >
                      <span
                        style={{
                          fontSize: '11px',
                          color: '#555',
                        }}
                      >
                        {n.owner}/{n.repo} #{n.number}
                      </span>
                      <span
                        style={{
                          fontSize: '10px',
                          color: '#fff',
                          backgroundColor: '#0969da',
                          borderRadius: '10px',
                          padding: '1px 6px',
                        }}
                      >
                        {formatKind(n.kind)}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: '12px',
                        color: '#24292f',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {n.title}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {issues.length > 0 && (
            <section>
              <h2
                style={{
                  fontSize: '12px',
                  fontWeight: 600,
                  margin: '4px 0',
                  borderBottom: '1px solid #ddd',
                  paddingBottom: '2px',
                }}
              >
                Issues
              </h2>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {issues.map((n) => (
                  <li
                    key={n.id}
                    style={{
                      padding: '4px 0',
                      borderBottom: '1px solid #eee',
                      cursor: 'pointer',
                    }}
                    onClick={() => handleOpen(n)}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        marginBottom: '2px',
                      }}
                    >
                      <span
                        style={{
                          fontSize: '11px',
                          color: '#555',
                        }}
                      >
                        {n.owner}/{n.repo} #{n.number}
                      </span>
                      <span
                        style={{
                          fontSize: '10px',
                          color: '#fff',
                          backgroundColor: '#0969da',
                          borderRadius: '10px',
                          padding: '1px 6px',
                        }}
                      >
                        {formatKind(n.kind)}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: '12px',
                        color: '#24292f',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {n.title}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
};

export default App;
