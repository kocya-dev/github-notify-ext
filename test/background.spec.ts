import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { WatchTargetRepo } from '../src/background/index';

// jsdom 環境では chrome API が存在しないため、最低限のモックを構成する
declare const global: any;

function setupChromeMock() {
  const alarmsListeners: Array<(alarm: { name: string }) => void> = [];
  const runtimeInstalledListeners: Array<() => void> = [];

  const chromeMock = {
    storage: {
      sync: {
        get: vi.fn((defaults: any, cb: (items: any) => void) => {
          // デフォルト値をそのまま返す
          cb(defaults);
        }),
      },
      local: {
        get: vi.fn((defaults: any, cb: (items: any) => void) => {
          cb(defaults);
        }),
        set: vi.fn((items: any, cb?: () => void) => {
          cb?.();
        }),
      },
    },
    action: {
      setBadgeText: vi.fn(),
      setBadgeBackgroundColor: vi.fn(),
    },
    alarms: {
      clear: vi.fn((name: string, cb: () => void) => cb()),
      create: vi.fn(),
      onAlarm: {
        addListener: vi.fn((fn: (alarm: { name: string }) => void) => {
          alarmsListeners.push(fn);
        }),
      },
      // テスト用にリスナー呼び出しを行うヘルパー
      __trigger(name: string) {
        for (const l of alarmsListeners) l({ name });
      },
    },
    runtime: {
      onInstalled: {
        addListener: vi.fn((fn: () => void) => {
          runtimeInstalledListeners.push(fn);
        }),
      },
    },
  } as any;

  global.chrome = chromeMock;
  return chromeMock;
}

describe('background watch logic (sanity)', () => {
  let chromeMock: any;

  beforeEach(() => {
    chromeMock = setupChromeMock();
    vi.resetModules();
  });

  afterEach(() => {
    // 汚染を避けるため削除
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (global as any).chrome;
  });

  it('WatchTargetRepo 型が期待通りに扱える', () => {
    const repos: WatchTargetRepo[] = [
      { owner: 'owner1', name: 'repo1' },
      { owner: 'owner2', name: 'repo2' },
    ];
    expect(repos).toHaveLength(2);
    expect(repos[0].owner).toBe('owner1');
  });

  it('background スクリプトが読み込まれると onInstalled / onAlarm リスナーが登録される', async () => {
    await import('../src/background/index');

    // onInstalled リスナー登録確認
    expect(chromeMock.runtime.onInstalled.addListener).toHaveBeenCalledTimes(1);
    // onAlarm リスナー登録確認
    expect(chromeMock.alarms.onAlarm.addListener).toHaveBeenCalledTimes(1);
  });

  it('アラーム発火時にストレージへアクセスしようとする', async () => {
    await import('../src/background/index');

    // アラームを擬似的に発火
    chromeMock.alarms.__trigger('github-notify-watch');

    // runWatchCycle 内で storage.sync.get が 1 回以上呼ばれていることをざっくり確認
    expect(chromeMock.storage.sync.get).toHaveBeenCalled();
  });
});
