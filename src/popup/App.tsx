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
  // 既読状態は別ストアで管理するため、この型自体は変更しない
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

/**
 * 通知一覧を PR と Issue に振り分け、検出日時の降順で整列する。
 * @param items 通知一覧
 * @returns PR と Issue に分割された通知一覧
 */
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

/**
 * 通知種別をポップアップ表示用の日本語ラベルに変換する。
 * @param kind 通知種別
 * @returns 日本語ラベル
 */
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

/**
 * ポップアップのルートコンポーネント。
 *
 * - local storage から通知一覧と既読 ID を読み込む
 * - sync storage から通知の有効/無効設定を読み込む
 * - クリックした通知を既読にし、バッジ数を減算する
 */
const App: React.FC = () => {
  const [notifications, setNotifications] = useState<StoredNotification[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [settings, setSettings] = useState<PopupSettings | null>(null);
  const [readIds, setReadIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    chrome.storage.local.get(
      { notifications: [], readNotificationIds: [], badgeCount: 0 },
      (items) => {
        const list = Array.isArray(items.notifications)
          ? (items.notifications as StoredNotification[])
          : [];
        const readList: string[] = Array.isArray(items.readNotificationIds)
          ? (items.readNotificationIds as string[])
          : [];

        setNotifications(list);
        setReadIds(new Set(readList));
        setIsLoading(false);
      },
    );
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

  /**
   * 通知を既読にし、
   * - 通知一覧から既読項目を除外
   * - readNotificationIds を更新
   * - バッジカウントを 1 減算
   * を行う。
   * @param id 既読にする通知 ID
   */
  const markAsReadAndUpdate = (id: string) => {
    chrome.storage.local.get(
      { notifications: [], readNotificationIds: [], badgeCount: 0 },
      (items) => {
        const notificationsInStore: StoredNotification[] = Array.isArray(items.notifications)
          ? (items.notifications as StoredNotification[])
          : [];
        const readList: string[] = Array.isArray(items.readNotificationIds)
          ? (items.readNotificationIds as string[])
          : [];
        const readSet = new Set(readList);

        if (!readSet.has(id)) {
          readSet.add(id);
        }

        // 既読になったものは一覧から削除
        const remaining = notificationsInStore.filter((n) => !readSet.has(n.id));

        // バッジは 0 未満にならないように減算
        const newBadgeCount = Math.max(0, Number(items.badgeCount ?? 0) - 1);

        chrome.storage.local.set(
          {
            notifications: remaining,
            readNotificationIds: Array.from(readSet),
            badgeCount: newBadgeCount,
          },
          () => {
            // ポップアップ表示中の state も同期
            setNotifications(remaining);
            setReadIds(readSet);
            // バッジの見た目更新は background 側のロジックに合わせておく
            chrome.action.setBadgeText({ text: newBadgeCount > 0 ? String(newBadgeCount) : '' });
          },
        );
      },
    );
  };

  /**
   * 通知をクリックした際に GitHub 上の該当 PR/Issue を新しいタブで開き、
   * その通知を既読として処理する。
   * @param n クリックされた通知
   */
  const handleOpen = (n: StoredNotification) => {
    if (n.url) {
      chrome.tabs.create({ url: n.url });
    }
    // クリック時に既読として扱い、ストアとバッジを更新
    markAsReadAndUpdate(n.id);
  };

  /**
   * 通知種別ごとの ON/OFF 設定に基づき、
   * 該当の通知種別が表示対象かどうかを判定する。
   * @param kind 通知種別
   * @returns true: 表示する / false: 非表示にする
   */
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
                      display: 'flex',
                      alignItems: 'center',
                    }}
                    onClick={() => handleOpen(n)}
                  >
                    <span
                      style={{
                        width: 14,
                        height: 14,
                        borderRadius: '50%',
                        border: '1px solid #ccc',
                        marginRight: 6,
                        backgroundColor: readIds.has(n.id) ? '#fff' : '#2da44e',
                      }}
                      title={readIds.has(n.id) ? '既読' : '未読'}
                    />
                    <div
                      style={{
                        flex: 1,
                        display: 'flex',
                        flexDirection: 'column',
                      }}
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
                      display: 'flex',
                      alignItems: 'center',
                    }}
                    onClick={() => handleOpen(n)}
                  >
                    <span
                      style={{
                        width: 14,
                        height: 14,
                        borderRadius: '50%',
                        border: '1px solid #ccc',
                        marginRight: 6,
                        backgroundColor: readIds.has(n.id) ? '#fff' : '#2da44e',
                      }}
                      title={readIds.has(n.id) ? '既読' : '未読'}
                    />
                    <div
                      style={{
                        flex: 1,
                        display: 'flex',
                        flexDirection: 'column',
                      }}
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
