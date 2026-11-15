// QQ 多账号网关：一套工具接管多个 OneBot 11 后端，按账号把消息投进各自的 DSH 会话。
//
// 这个文件只做三件事：声明名字、声明配置结构、把活交给 src/hub.js。
// 真正会出错的东西都在 hub 里，那样测试环境才够得着（这里要 import schemastery，
// 没装 DSH 的地方跑不起来）。
//
// 设计要点，改动前先读：
// · 一个账号 = 一个 OneBot 后端 = 一份配置 + 一组端口。别给每个号起一个网关实例，
//   那正是要拆掉的镜像做法。
// · 工具只有一套，account 参数分人。
// · 投消息走 agent.followup(message)，message 必须是对象，见 src/router.js 顶部那条警告。

// 默认导入，不是命名导入——selfwake 和 dsh-longing 都这么写，schemastery 是 CJS 默认导出。
import Schema from '@deepseek-ai/schemastery'
import { createHub, createFileLogger, logPath } from './src/hub.js'
import { registerWebApi } from './src/webapi.js'

export const name = '@local/dsh-qq-gateway'
export const inject = ['tools', 'agents']

const AccountSchema = Schema.object({
  id: Schema.string()
    .default('')
    .description('账号别名，工具里用它区分是谁。只用字母数字下划线连字符，例：hua'),
  label: Schema.string()
    .default('')
    .description('侧边栏上显示的名字。留空就用 id。设置页里能改'),
  uin: Schema.string()
    .default('')
    .description('这个连接绑的 QQ 号，给人和设置页看的。实际连上的是哪个号由后端探出来，两边对不上时设置页会标出来'),
  httpUrl: Schema.string()
    .default('')
    .description('这个号的 OneBot 11 HTTP 地址，必须填。三个号各一组端口。给默认值是有害的：哪个号忘了填就会静默连到默认那个号上，消息串进别人的会话'),
  accessToken: Schema.string()
    .default('')
    .description('后端令牌，按后端配置里那个填。没设就留空'),
  wsToken: Schema.string()
    .default('')
    .description('收事件那个 WebSocket 的令牌。跟 HTTP 的 accessToken 通常是两把，别混——拿 HTTP 那把连 WS 会 1006。留空就退回 accessToken'),
  wsUrl: Schema.string()
    .default('')
    .description('收事件的 WebSocket 地址，例：ws://127.0.0.1:3011。留空就收不到消息'),
  session: Schema.string()
    .default('')
    .description('这个号的消息投进哪个 DSH 会话。带不带 session- 前缀都认。留空就只发不收'),
  owner: Schema.string()
    .default('')
    .description('这个号上哪个 QQ 说的话算指令。投递时会标成［主人］，其余标［外人］，上层据此分开处置'),
  allow: Schema.object({
    private: Schema.array(Schema.string()).default([]).description('允许私聊的 QQ 号。留空 = 谁都不理'),
    groups: Schema.array(Schema.string()).default([]).description('允许的群号。留空 = 哪个群都不理')
  }).description('白名单。空数组是「谁都不理」，不是「全放」')
})

export const Config = Schema.object({
  accounts: Schema.array(AccountSchema)
    .default([])
    .description('要接管的 QQ 账号。一个号一项，各连自己的后端'),
  probeIntervalSec: Schema.number()
    .default(120)
    .description('多少秒探一次登录态，写进 qq_status。0 就不探'),
  followupTimeoutSec: Schema.number()
    .default(300)
    .description('投一条消息后，等会话那一边接住的上限，超时就判这条没投进去。别调太小，回合在跑时本来就要等'),
  groupWakeMode: Schema.string()
    .default('mention')
    .description('群聊什么时候唤醒：mention = 只在被点名、被拍、被引用时投（闲聊只记账，被叫时一起带过去）；all = 来一条投一条，吵且费'),
  contextMaxCount: Schema.number()
    .default(20)
    .description('被叫起来时最多带前几条攒下的消息。按条数和字符双卡，超了丢老的'),
  contextMaxChars: Schema.number()
    .default(6000)
    .description('被叫起来时最多带多少字符的前因。攒了一天的闲聊不能一股脑全塞进去，那样一次比每条都投还贵'),
  batchQuietSec: Schema.number()
    .default(15)
    .description('群里安静多少秒才把攒下的几条一起投一次。调小反应快但回合多、费 token；调大省钱但可能等到人都散了'),
  criticalQuietSec: Schema.number()
    .default(1.2)
    .description('私聊、@ 到你、引用你那条这类问话的静默窗口。问话不能慢慢攒，慢了就答非所问'),
  batchMaxWaitSec: Schema.number()
    .default(600)
    .description('一直有人说话时，最多攒多久必须投一次，防止热闹起来永远投不出去。这条只兜闲聊，要紧的走 criticalQuietSec 那条快路，所以可以放宽'),
  maxQueueAgeSec: Schema.number()
    .default(300)
    .description('消息从进队到真正投递的上限。前面的回合卡住时，后面排队的超过这个时间就丢，不投隔了太久的旧消息。私聊和 @ 到自己的不丢'),
  stateFile: Schema.string()
    .default('')
    .description('状态落盘位置。留空放在 DSH 家目录下的 qq-gateway/state.json'),
  logFile: Schema.string()
    .default('')
    .description('关键事件另写一份到这里，验收时数投递/搁置/拦下/丢弃/失败各几行。留空放 DSH 家目录下的 qq-gateway/gateway.log'),
  label: Schema.string()
    .default('')
    .description('投递时挂在唤醒头前面的标记，例：新。新旧两套同时挂着时用来分辨一条消息是谁投的；卸掉旧的那套后清空'),
  snowlumaStartScript: Schema.string()
    .default('D:\\AI\\snowluma\\start-snowluma.cmd')
    .description('侧边栏那个按钮点下去要拉的启动脚本。SnowLuma 的守护入口，换成别的位置就改这里')
})

export function apply(ctx, config = {}) {
  const toConsole = (msg) => {
    try { ctx?.logger?.info?.('[qq-gateway] ' + msg) } catch {}
  }
  // 关键事件另写一份文件：验收要数「投递/搁置/拦下/丢弃/失败」各几行，
  // DSH 的日志只往终端走，过了就没了。
  const toFile = createFileLogger(config?.logFile ? String(config.logFile) : logPath(''))
  const log = toFile ? (msg) => { toConsole(msg); toFile(msg) } : toConsole
  const built = createHub(ctx, config, log)
  // 一定要走 ctx.effect：只 return 一个函数的话，重载时旧实例的 WS 不会被关。
  // 实测每重载一次就多留一条活连接，SnowLuma 那边几个客户端抢同一路，互相踢，
  // 表现就是「连上→60 秒后断→重连」死循环。
  // 侧边栏按钮的数据源。webServer 是可选依赖，可能比本插件晚就绪，
  // 所以挂不上就补几次；一直挂不上也不影响收发，只是按钮没数字。
  const mountWeb = () => registerWebApi(ctx, built, config, log)
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      built.start()
      let disposeWeb = null
      let tries = 0
      const tryMount = () => {
        if (disposeWeb) return
        const d = mountWeb()
        if (typeof d === 'function') disposeWeb = d
      }
      tryMount()
      const timer = setInterval(() => {
        if (disposeWeb || tries >= 10) { clearInterval(timer); return }
        tries += 1
        tryMount()
      }, 1000)
      if (typeof timer.unref === 'function') timer.unref()
      return () => {
        clearInterval(timer)
        try { disposeWeb?.() } catch {}
        try { built.dispose() } catch {}
      }
    }, 'qq-gateway: 账号与网关')
    return
  }
  built.start()
  return built.dispose
}
