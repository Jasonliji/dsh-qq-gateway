# 交接：把 QQ 状态按钮并进网关（2026-11-15）

> **2026-11-15 22:50 已解决，收尾人：鱼鱼。**
> 卡点不是前两个 id/exports 问题，是 `exports.inject = []` —— cordis 因此不调用 `apply`，
> fiber 停在 loading。改成 `["slots"]` 后侧边栏立刻出现，三个号一行一个，实测三个绿点。
> 完整定位模板写进 `PITFALLS.md` 第 15 条。下面保留了当时的排查记录，当作过程存档。

## 一句话

原 `dsh-qq-hub` 插件（鱼鱼写的：侧边栏显示 QQ 连接状态 + 一键启动）在清理旧桥时被我误删，源码没留。
按主人要求，它的功能要**并进 `@local/dsh-qq-gateway`**（`qq-bridge-v2`），不再单开一个插件。
后端和前端都写完了，**但侧边栏按钮始终不出现**。

## 已经做完的（别重写）

### 后端 `src/webapi.js`

- `ctx.get('webServer')?.register({ kind: 'prefix', path: '/dsh-qq-gateway', handler })`
- `GET /dsh-qq-gateway/api/status` → `{ ok, accounts: [{ id, httpUrl, session, online, nickname, selfId, error }] }`
  数据来自 `hub.accounts[].client.probe()`，跟 `qq_status` 工具同一份
- `POST /dsh-qq-gateway/api/start` → 拉 `D:\AI\snowluma\start-snowluma.cmd`
  **带闸**：只要有任一账号在线就返回 `{ started: false, reason: '已经有号在线，不用再起' }`，
  防止两个 SnowLuma 抢同一组端口
- 接口实测通过：status 200 返回三个号；start 在全部在线时正确挡住

### 挂载 `index.js`

- `import { registerWebApi } from './src/webapi.js'`
- `apply()` 里 `ctx.effect` 内 `built.start()` 之后调 `mountWeb()`；
  `webServer` 可能晚就绪，1 秒间隔最多补 10 次
- 配置项 `snowlumaStartScript`（默认 `D:\AI\snowluma\start-snowluma.cmd`）

### 前端 `client.js`（根目录）

- `window.__ModuleLoader__.load({ id: '@local/dsh-qq-gateway', factory: (require) => {...} })`
- `exports.apply = (ctx) => ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'qq-gateway-entry' }, QqGatewayEntry)))`
- UI：收起时一个状态点 + `QQ 3/3` + 小三角；展开后每个号一行（id / 昵称 / 绿红点），点掉线的行会调 start
- 15 秒轮询 status

### `package.json`

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "immediately": true, "inject": [] }
},
"exports": {
  ".": { "import": "./index.js" },
  "./client": "./client.js",
  "./package.json": "./package.json",
  "./locale/*.json": "./locale/*.json",
  "./icon": "./icon.svg"
}
```

## 卡在哪

用 `cordis_inspect_query({ platform: 'client', provider: 'Slots', method: 'listSubTree', input: { root: 'sidebar.footer.action' } })`
查 occupants，只有 DSH 自带的 `remote-bridge` 和 `cordis-panel`，**没有 `qq-gateway-entry`**。
说明前端那半边没被加载/执行，或者执行了但没注册进槽位。

已经修过两个真问题，都没解决：

1. 第一版 `package.json` **缺 `exports['./client']`** —— 已补（DSH 按这个键找网页半边的入口文件）
2. 第一版 `client.js` 的 loader id 写成 `"dsh-qq-gateway"`，**包名是 `@local/dsh-qq-gateway`** —— 已改成完整包名

两次改完都重启过 DSH（GUI 端口 60570 → 51893 → 63171 → 58744，能确认是真重启不是刷新页面）。

## 已经排除的（鱼鱼 2026-11-15 确认过）

- `dsh.client` 只要 `platform: "web"`，`inject: []` 空着没问题（`ctx.slots` 是浏览器端自带服务）
- `immediately` 只影响要不要预取，不影响挂载
- 入口放根目录 `client.js` 没问题（`dsh-bili-toy` 就是这么放），`exports["./client"]` 指对即可
- 改完必须重启 DSH，刷新页面等不到

## 下一步建议（按这个顺序）

1. **先确认 bundle 有没有被宿主收进 `clientModules.table`**。
   宿主服务 `clientModules` 有 `clientPath(id)` / `graph()`，但 `cordis_inspect` 只能调 `listService`，调不到那两个。
   可行的话在 inspect 里加一条，或者临时写个调试插件把 `graph()` 打出来。
   - 在 table 里 → 问题在前端执行，看 console
   - 不在 table 里 → 问题在宿主扫描，回去查 manifest / entry
2. 前端 console 看 `window.__DSH_BOOT__` 里有没有 `@local/dsh-qq-gateway` 这个 entry；
   有的话再看它加载时报什么错（`window.__ModuleLoader__` 的执行错误一般会在 console 里）
3. 找一个**当前真在跑**的 client 插件做逐行 diff。注意 `dsh-bili-toy` 未必是启用的，先 `list_bundles` 确认
4. 我拿不到 DSH web 的访问凭据：`C:\Users\<用户>\.dsh\remote-web-ui-registry\desktop.json` 里有 `secret`，
   但 `?token=` / `?secret=` / `Authorization: Bearer` / `x-dsh-secret` 全是 401，
   所以没法自己抓 `/plugins` 那个 bundle 路由来验证。谁有办法拿到访问态，这一步能直接看到答案

## 文件位置

- 插件源码：`qq-bridge-v2`
  - `src/webapi.js` —— 后端路由（新增）
  - `client.js` —— 前端（新增）
  - `index.js` —— 改了三处：import、apply 里挂 webapi、Config 加 `snowlumaStartScript`
  - `package.json` —— 加了 `exports['./client']` 和 `dsh.client`
- 改前备份：整个插件目录做一份拷贝（不含 node_modules），放在自己的备份区即可
- 原 `dsh-qq-hub` 源码：**已删除，无备份**。`fs.rmSync` 是永久删除，回收站里也没有
- 坑记录：`qq-bridge-v2/docs/PITFALLS.md` 第 13、14 条

## 不要动的

- QQ 三个号（lan / hua / yuyu）现在收发都正常。改这个插件只动 client 半边和 webapi，
  **别碰 `src/hub.js` / `src/router.js` / `src/onebot.js`**
- `D:\AI\snowluma\` 是 SnowLuma 的启动器（`snowluma-daemon.vbs` + `start-snowluma.cmd`），
  删了三个号会一起断
- 每次改完要 `set_bundle` 往返或重启 DSH 才对前端生效
