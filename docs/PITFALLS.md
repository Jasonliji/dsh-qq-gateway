# 装机时踩到的坑（真机，不是单测）

按踩到的顺序。单测全绿的时候这些都还在。

## 1. schemastery 是默认导出

```
SyntaxError: The requested module '@deepseek-ai/schemastery' does not provide an export named 'Schema'
```

**错**：`import { Schema } from '@deepseek-ai/schemastery'`
**对**：`import Schema from '@deepseek-ai/schemastery'`

装了第一次直接 `application: failed`。改完重载就好，不用重装。

## 2. WS 的令牌跟 HTTP 的令牌是两把

OneBot 的配置里 `networks.httpServers[0].accessToken` 和 `networks.wsServers[0].accessToken` **不相等**（实测 SnowLuma：`a1b2c3…` vs `x9y8z7…`）。

拿 HTTP 那把去连 WebSocket，表现是连上立刻 `1006`，然后无限重连。日志里只有「WS 断开，N 秒后重连」，看不出是令牌错。

所以配置里 `accessToken`（HTTP）和 `wsToken`（WS）要分开填。

## 3. 令牌只能走 query，不能塞 header

```js
// 错的：Node 自带 WebSocket 的第二个参数是子协议，{ headers } 被当协议名，鉴权发不出去
new WebSocket(url, { headers: { authorization: 'Bearer ' + token } })

// 对的
new WebSocket(url + '?access_token=' + encodeURIComponent(token))
```

## 4. 改配置不必重启 DSH

删了 / 改了 profile 的 `cordis.patch.yml` 之后，用 `plugin_manager` 的 `set_plugin` **关掉再开**，就会重新读 patch 和新配置。不用重启整个 DSH。

（这是试出来的，之前以为必须重启。）

## 5. profile 的 patch 里加 config 覆盖能生效

```yaml
- id: qq-gateway
  config:
    accounts: [...]
```

**整份替换** config——没写的字段走插件默认值，不是合并。

## 6. 用 WMI 起进程要带隐藏，否则窗口跑到前台

`Invoke-CimMethod -ClassName Win32_Process -MethodName Create` 拉起的进程默认带窗口。SnowLuma 这么起来，窗口就顶到前台了，人会看到。

要隐藏就用 wscript：`shell.Run "...", 0, True`，0 是隐藏。

## 7. vbs 里别写中文注释

文件按 UTF-8 无 BOM 存，WScript 按 ANSI 读，中文注释变乱码把语法搞坏。表现是 wscript 进程活着但不干活（Run 那行根本没执行）。

写纯 ASCII。

## 8. 探 OneBot 不带令牌，看起来像没起来

```
POST http://127.0.0.1:<port>/get_login_info
```

不带头会 401。我在轮询里没带，一百秒全「还没起来」，差点以为 SnowLuma 挂了——其实日志里它一直在正常响应两套桥的探活。

## 9. 装之前先跟改同一个 profile 的人打招呼

`package.json` 的 `dsh.profile.bundles` 是跟别的 agent 共用的。DSH 有 `withFileLock` 和 `writeFileAtomic`，单次写不会写半截；但「各自读一遍再各写一遍」这个序列不原子，后写的照样盖前头的。

装之前喊一声，让对方当场回「没在动」，比看 `mtime` 靠得住——时间戳说明不了下一秒。

## 10. 插件重载会漏 WS 连接，cleanup 得用 ctx.effect

`apply` 里 `return dispose` 不够。实测每重载一次，DSH 进程里就多留一条活着的 WebSocket：

```
重载前  ws3011=3  ws3021=5
关掉后  ws3011=3  ws3021=5   ← set_plugin(false) 一条都没关
重开    ws3011=4  ws3021=6   ← 又多一条
```

后果不是慢，是错：SnowLuma 那头几个客户端抢同一路互相踢，表现成「连上 → 60 秒后断 → 重连」的死循环，看着像鉴权问题，其实是自己跟自己抢。

**对**：

```js
ctx.effect(() => {
  built.start()
  return () => built.dispose()
}, 'qq-gateway: 账号与网关')
```

bili-toy、pet-hub、fish-tone 都这么写。已经漏在进程里的连接改代码清不掉（旧 client 引用丢了，没人能调它的 stop），只能重启宿主。

## 11. 重载会撞 HMR 嵌套

连着关一次开一次，第二次可能被拒：

```
"application": "failed"
"diagnostic": "HMR transactions cannot be nested"
```

这不代表插件坏了——两个账号还在线，旧代码还在跑。只是这次改动没生效。等一个动作做完再发下一个，别连着来。

## 12. 自己说的话要单独一个身份

投递时一条自己发的消息：

```
[] 我(self)［外人］［id:-123456］
```

两个毛病。一是状态文件里 `identity: 'self'` 存得对，但渲染只分了 `owner` / `other`，self 落进 else 就成了「外人」——被叫起来看到自己说的话标着外人，会以为有人替自己说了话。二是 `ev.time` 空的时候渲染出空括号。

改法：身份分三档（主人 / 自己说的 / 外人），时间空了就不打那对方括号。

顺带记一条设计：`pendingAll` **故意**把 self 那几条一起带上——那是上下文，不是新消息。别因为「自己说的不该投」把它去掉，去掉就接不上前因了。

## 13. 网页半边要 exports['./client']，光有 dsh.client 段不够

症状：`package.json` 里写了 `dsh.client: { platform: 'web' }`，根目录也放了 `client.js`，
但侧边栏那个按钮就是不出现。用 `cordis_inspect` 查 `sidebar.footer.action` 的 occupants，
只有 DSH 自带的 `remote-bridge` 和 `cordis-panel`，没有自己的 id。

原因：DSH 找 client 入口看 `package.json` 的 `exports['./client']`，不按「根目录有没有 client.js」猜。

修法：

```json
"exports": {
  ".": { "import": "./index.js" },
  "./client": "./client.js",
  "./package.json": "./package.json"
}
```

另外：client 半边只在 DSH **启动时**加载，插件的 set_bundle 热重载拉不动它。
改完 exports 必须重启 DSH，光重载插件看不到变化。

参照实现：`plugins/dsh-longing-entry`（`exports['./client']` + 根目录 `client.js` +
`window.__ModuleLoader__.load({ id, factory })`，factory 里 `exports.apply` 里做 `ctx.slots.inject`）。

## 14. window.__ModuleLoader__.load 的 id 必须严格等于包名

这是上一条后面真正的卡点，比 exports 更隐蔽。

症状：`exports['./client']` 有了，`dsh.client` 也写了，`client.js` 语法没问题，DSH 也重启了，
但侧边栏那个按钮就是不出现。`cordis_inspect` 查 `sidebar.footer.action` 的 occupants，
还是只有 DSH 自带的，没有你的 id。

原因：前端 boot 时从宿主拿 `manifest.plugins`，`prefetch(e.id)` 和挂载都按**包名**认领。
`window.__ModuleLoader__.load({ id })` 里那个 id 跟包名对不上（比如少了 `@local/` 作用域），
代码照样执行、模块照样注册，但没有人来领它，界面上什么都没有。

对：
- 包 `dsh-longing-entry` → `id: "dsh-longing-entry"`
- 包 `@local/dsh-bili-toy` → `id: '@local/dsh-bili-toy'`
- 包 `@local/dsh-qq-gateway` → `id: "@local/dsh-qq-gateway"`

错：包 `@local/dsh-qq-gateway` 写成 `id: "dsh-qq-gateway"`。

配套的几条（2026-11-15 跟鱼鱼核过）：
- `dsh.client` 只要 `platform: "web"`，`inject` **不能是空数组**，见第 15 条
- `immediately` 只决定要不要预取，不影响挂载
- 入口放根目录 `client.js` 没问题（`dsh-bili-toy` 就是这么放的），`exports["./client"]` 指对即可
- `package.json` / `exports` / 包名这类宿主启动时扫的东西，改完**必须重启 DSH**
- 但**只改 `client.js` 内容不用重启**：宿主的 HMR watcher 盯着 bundle 的 mtime/size，
  文件一落盘就重读、重算 rev。刷新页面就能拿到新版本（2026-11-15 实测）

## 15. exports.inject 写 [] 会让 cordis 干脆不调 apply（真正的最终卡点）

前三条都修对了——exports 有了、loader id 是完整包名、DSH 也重启了——按钮还是不出现。

定位办法（这套是通杀模板，以后调前端挂载照抄）：

1. 自己签个浏览器 cookie，绕过 `dsh web` 的 401：
   - secret 在 `~/.dsh/.credentials.yaml` 的 `client-connection/browser-session.secret`
     （**不是** `remote-web-ui-registry/desktop.json` 里那个，那两个是两套）
   - cookie 名 `dsh-auth-` + base64url(sha256(`127.0.0.1:<端口>`))
   - 值 `v1.<base64url(payload)>.<base64url(hmac-sha256(secret, body))>`，
     payload `{ version:1, authority, issuedAt, expiresAt }`
2. `curl` 首页，从 HTML 里抠 `__DSH_BOOT__` 的 JSON，看 `entries` 里有没有你的包。
   **有 → 宿主扫描这一半没问题，别再往宿主找了**（2026-11-15 实测：`@local/dsh-qq-gateway`
   在 entries 里，`immediately: true`，也在 application 批次里）
3. 直接 curl 那条 `plugins/??<包名>/client.js&rev=<rev>`，确认内容是新的
4. 还有一条更快的：前端 console 会直接说
   `web boot: warning: 1 entry did not activate` + `@local/dsh-qq-gateway: loading`

**"loading" 就是答案**：fiber 卡在第一次启动，`apply` 从头到尾没被调用。

原因：cordis 按 `plugin.inject` 建依赖图。`inject: []` 不是一个"无依赖"的声明，
而是让 fiber 停在 loading 等一个永远不会来的信号。`ctx.slots` 明明拿得到
（实测 `slots=object`），但 apply 根本没跑，探针一条都不报。

对：

```js
exports.apply = apply;
exports.inject = ["slots"];   // 拿 slots 就写出来，别留空数组
```

改成 `["slots"]`、刷新页面，三秒内 sidebar.footer.action 出现 `qq-gateway-entry`，
按钮和三行账号全在。

**这条推翻了我之前判断的「`inject: []` 空着没问题」**——那是照着 `dsh-longing-entry`
的写法推的，longing 现在根本没启用，等于拿一个没在跑的样本当证据。
真正能跑的对照是 `plugins/dsh-bili-toy`：
`inject: ['slots']` + `const slots = ctx.get('slots') || ctx.slots` + 拿不到就 return。

**怎么把探针塞进浏览器**（没有 devtools 也能测）：借 bili-toy 现成的
`GET /api/bili-toy/ping?where=<标记>&x=<附加>`，它写 `~/.dsh/bili-toy/toy.log`。
在 client.js 里脚本级 / factory 里 / apply 第一行各打一条，改完刷新，看日志新增到哪一步停的。
一分钱后端改动都不用。

## 16. 宿主侧代码改完不生效，但也不用重启 DSH

症状：`src/webapi.js` 加了一条路由，刷新页面照旧 `{"ok":false,"error":"not found"}`，
等 HMR 也不来。

原因：HMR 会主动 watch 的是 **client bundle**（改了立刻重读、重算 rev）。
宿主侧是 ESM 静态 `import`，文件改了进程内存里还是旧的。

但 `@deepseek-ai/dsh-hmr` 的 README 写明了一件事：已链接包（`link:` 依赖）的文件变化，
会在**下一次 profile 重新组合**时生效，包括 `node_modules` 下的和链接目标里的。

踢一下就行——改 `~/.dsh/profiles/desktop/cordis.patch.yml`，加一行注释存盘，
七秒内重组完成，新路由就在了。**不用重启 DSH**，三个号会断一下再自己接回来。

```bash
# 加一行注释到 patch 里，等 7 秒
```

要是改的是 `package.json` / `exports` / 包名，那还是得重启：那些是宿主启动时扫一次的。

## 17. 设置页要改配置，得先给 profile 挂上 config-editor

想把「改名字 / 换对话 / 改白名单」做成设置页，绕不开一件事：改完得有个地方**写回配置**。
自己拿 fs 改 `cordis.patch.yml` 能写，但会丢注释、绕过校验，写完还得自己触发重载。

DSH 自带 `@deepseek-ai/dsh-config-editor` 就是干这个的，只是 profile 里默认没起。
在 `~/.dsh/profiles/desktop/cordis.patch.yml` 加两条：

```yaml
- id: config-editor
  name: "@deepseek-ai/dsh-config-editor"
```

起来之后 `ctx.get('configEditor')` 就能拿到，接口：

```js
const editor = ctx.get('configEditor')
const entry = editor.entries().find(e => e.options.id === 'qq-gateway')
await editor.edit(entry, (current) => ({ ...current, accounts: 新的 }))
```

它会先验一遍候选值，再原子替换 patch 里 `- id: <你的条目>` 的 `config:`，
保留其他行的注释和 `!!js` 表达式，写完按正常生命周期重载插件。

要注意的：

- **重载 = 插件 dispose 再 build**，QQ 三个号会断几秒再自己连回来。所以设置页做成「点保存一次性提交」，别做成一改就存
- `entries()` 只给能从 profile patch 唯一定位到的条目，配置如果被 home patch 或命令行覆盖，`edit()` 会直接报错不写文件
- 白名单这类数组整份替换，不做合并。合并会让人删不掉一条，删了重启又回来
- 会话列表用 `ctx.get('sessions').list()`，只给**活着的**会话（投递本来也只认活着的）。
  `Session` 对象没有 title 字段，只有 `header.cwd`，拿目录末段当名字
