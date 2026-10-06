'use strict';

const { createDeniedNotifier } = require('../lib/web/denied-notify');
const { BROWSER_BACKGROUND_DOMAINS, isBrowserBackground } = require('../lib/browser-background');

describe('对话里的拦截提示', () => {
    test('只提示本轮新增的拦截；同一域名只提示一次；忽略已放行与浏览器后台请求', () => {
        let records = [{ host: 'old.example.com', port: 443, count: 3 }];
        const out = [];
        const notifier = createDeniedNotifier({
            read: () => records,
            isIgnored: host => host === 'allowed.example.com' || isBrowserBackground(host),
            emit: text => out.push(text)
        });
        notifier.start();
        notifier.tick();
        expect(out).toEqual([]); // 开始前就存在的记录不提示
        records = [
            { host: 'old.example.com', port: 443, count: 3 },
            { host: 'pss.bdstatic.com', port: 443, count: 1 },
            { host: 'allowed.example.com', port: 443, count: 1 },
            { host: 'www.google.com', port: 443, count: 5 }
        ];
        notifier.tick();
        expect(out).toEqual(['[提示] 已拦截：pss.bdstatic.com（不在白名单），可在「容器 → 网络」里一键允许']);
        records = [...records.slice(0, 1), { host: 'pss.bdstatic.com', port: 443, count: 4 }, { host: 'old.example.com', port: 80, count: 1 }];
        notifier.tick();
        expect(out.length).toBe(2); // pss 不重复；同域名不同端口算它的新记录但域名已提示过 → 只有 old.example.com:80 被提示
        expect(out[1]).toContain('old.example.com');
        notifier.stop();
    });

    test('emit 抛异常（例如写历史失败）也不冒泡：定时器里的异常会打挂 serve', () => {
        const notifier = createDeniedNotifier({ read: () => [{ host: 'a.example.com', port: 443, count: 1 }], isIgnored: () => false, emit: () => { throw new Error('ENOSPC'); } });
        expect(() => notifier.tick()).not.toThrow();
    });

    test('读记录失败不抛错', () => {
        const notifier = createDeniedNotifier({ read: () => { throw new Error('x'); }, isIgnored: () => false, emit: () => { throw new Error('should not'); } });
        notifier.start();
        expect(() => notifier.tick()).not.toThrow();
        notifier.stop();
    });
});

describe('浏览器后台请求列表', () => {
    test('精确匹配列表里的域名，不误伤其他谷歌域名与子域', () => {
        BROWSER_BACKGROUND_DOMAINS.forEach(host => expect(isBrowserBackground(host)).toBe(true));
        expect(isBrowserBackground('mail.google.com')).toBe(false);
        expect(isBrowserBackground('evil-www.google.com.example.com')).toBe(false);
        expect(isBrowserBackground('baidu.com')).toBe(false);
    });
});
