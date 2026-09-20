# Gather

面向小型社群的本地活动报名管理网页。管理员可创建活动、切换报名状态并查看名单；成员以 U1、U2、U3 模拟身份报名，每个身份可报名多场活动，同一活动最多报名一次。

## 技术栈

React + TypeScript + Vite，数据保存在当前浏览器的 localStorage。

## 本地运行

```bash
npm ci
npm run dev -- --host 127.0.0.1 --port 5174 --strictPort
```

测试与构建：

```bash
npm test
npm run build
```

生产预览：`npm run build && npm run preview -- --port 4173 --strictPort`，打开 http://127.0.0.1:4173 。

首版为单浏览器模拟身份演示，不提供真实登录、跨设备同步、多人并发抢名额或 P2 功能。验证结果见 `docs/开发记录/2026-09-20.md`。
