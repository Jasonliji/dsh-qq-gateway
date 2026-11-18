// 媒体：图片落地、语音转文件、合并转发展开、表情认名。
//
// 一条铁律：任何一样拿不到，都降级成一句说明，绝不让它把整条消息卡死。
// QQ 的 CDN 链接十几分钟就死，SnowLuma 也未必随时在线，媒体这条路上失败是常态。

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const FETCH_TIMEOUT_MS = 15000
// 取图上限。再大就别拉了：DSH 那边还有一道 maxImageBytes，拉了也进不去。
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_VOICE_BYTES = 16 * 1024 * 1024
const MAX_FORWARD_NODES = 60

export function defaultMediaDir() {
  return join(homedir(), '.dsh', 'qq-gateway-media')
}

export function ensureDir(dir) {
  try {
    mkdirSync(dir, { recursive: true })
    return dir
  } catch {
    return undefined
  }
}

async function fetchBytes(url, { timeout = FETCH_TIMEOUT_MS, maxBytes = MAX_IMAGE_BYTES } = {}) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeout)
  try {
    const res = await fetch(url, { signal: ctl.signal })
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status }
    const declared = Number(res.headers.get('content-length') || 0)
    if (declared && declared > maxBytes) return { ok: false, error: '太大 ' + declared + ' 字节' }
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.length > maxBytes) return { ok: false, error: '太大 ' + bytes.length + ' 字节' }
    return { ok: true, bytes, contentType: String(res.headers.get('content-type') || '') }
  } catch (error) {
    const reason = error?.name === 'AbortError' ? '下载超时' : (error?.message ?? String(error))
    return { ok: false, error: reason }
  } finally {
    clearTimeout(timer)
  }
}

/** 按文件头认类型。QQ 给的 content-type 经常是 octet-stream，信不过。 */
export function sniffMediaType(bytes, declared = '') {
  const b = bytes
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  const d = String(declared || '').toLowerCase()
  if (d.startsWith('image/')) return d.split(';')[0]
  return ''
}

/**
 * 把一张图交给 DSH 变成会话里的图。
 * 返回 { part } 或 { error }。逐张处理：一张坏了不至于连累同批其它张。
 */
export async function admitOneImage(ctx, { bytes, mediaType, name }) {
  const svc = ctx?.attachments
  if (!svc || typeof svc.admitPromptContent !== 'function') {
    return { error: '宿主没有 attachments 服务，给不了图' }
  }
  try {
    const parts = await svc.admitPromptContent([
      { type: 'image', mediaType, data: Buffer.from(bytes).toString('base64'), ...(name ? { name } : {}) }
    ])
    const part = Array.isArray(parts) ? parts.find((p) => p?.type === 'image') : undefined
    if (!part) return { error: 'admit 没返回图片块' }
    return { part }
  } catch (error) {
    return { error: error?.message ?? String(error) }
  }
}

/** 把一张图存本地，返回路径。给“塞不进会话”的时候用，模型还能自己 read_image。 */
export function saveImageLocally(dir, bytes, mediaType, name) {
  const d = ensureDir(dir)
  if (!d) return undefined
  const ext = mediaType === 'image/png' ? 'png'
    : mediaType === 'image/gif' ? 'gif'
      : mediaType === 'image/webp' ? 'webp'
        : 'jpg'
  const safe = String(name || 'img').replace(/[^\w.-]/g, '_').slice(0, 40)
  const file = join(d, Date.now() + '-' + safe + '.' + ext)
  try {
    writeFileSync(file, bytes)
    return file
  } catch {
    return undefined
  }
}

/**
 * 收进来的媒体 → 投递用的内容块 + 文字说明。
 * 返回 { parts: [], lines: [] }：parts 是给会话的图，lines 是已经写进正文的补充说明。
 */
export async function resolveIncoming(account, ctx, { media, log, dir }) {
  const parts = []
  const lines = []
  for (const m of Array.isArray(media) ? media : []) {
    if (m.kind === 'image') {
      // 收藏表情带 sub_type=1：那一类没有信息量，认个名就够了，不值得占一格上下文。
      if (m.asFace) {
        lines.push('[表情包' + (m.summary ? ' ' + m.summary : '') + ']')
        continue
      }
      const url = String(m.url || '')
      if (!url) { lines.push('[图片取不到地址]'); continue }
      const got = await fetchBytes(url)
      if (!got.ok) { lines.push('[图片没下来：' + got.error + ']'); continue }
      const mediaType = sniffMediaType(got.bytes, got.contentType)
      if (!mediaType) {
        const saved = saveImageLocally(dir, got.bytes, 'image/jpeg', 'raw')
        lines.push(saved ? '[图片格式认不出，存了一份 ' + saved + ']' : '[图片格式认不出]')
        continue
      }
      const admitted = await admitOneImage(ctx, { bytes: got.bytes, mediaType, name: 'qq-image' })
      if (admitted.part) { parts.push(admitted.part); continue }
      const saved = saveImageLocally(dir, got.bytes, mediaType, 'img')
      if (saved) {
        log?.('图片进不了会话，落盘了：' + admitted.error)
        lines.push('[图片已存本地 ' + saved + '，要看就用 read_image]')
      } else {
        lines.push('[图片没下来：' + admitted.error + ']')
      }
      continue
    }

    if (m.kind === 'record') {
      const r = await saveVoice(account, m, { dir, log })
      if (r.ok) {
        lines.push('[语音' + (r.seconds ? ' ' + r.seconds + ' 秒' : '') + '，已存 ' + r.path + '，要听就调 audio_transcribe]')
      } else {
        lines.push('[语音没取到：' + r.error + ']')
      }
      continue
    }

    if (m.kind === 'mface') {
      lines.push('[表情包' + (m.summary ? ' ' + m.summary : '') + ']')
      continue
    }

    if (m.kind === 'forward') {
      const r = await expandForward(account, m, { log })
      if (r.ok) lines.push('[合并转发 ' + r.count + ' 条]\n' + r.text)
      else lines.push('[合并转发没展开：' + r.error + ']')
      continue
    }
  }
  return { parts, lines }
}

/**
 * 语音落地：让后端转成 mp3，存到本地，正文里留下时长和路径。
 * 不在这里做转写——宿主有 audio_transcribe，需要听的时候再调，省一次模型推理。
 */
export async function saveVoice(account, media, { dir, log } = {}) {
  const file = String(media?.file || '')
  const url = String(media?.url || '')
  if (!file && !url) return { error: '语音没给 file 也没给 url' }
  const d = ensureDir(dir)
  if (!d) return { error: '媒体目录建不出来' }

  let bytes
  let seconds = 0
  let ext = 'mp3'
  try {
    // SnowLuma 的 get_record 带 out_format 会服务端转码并回 base64，比自己解 silk 稳。
    const info = await account.client.call('get_record', { file: file || url, out_format: 'mp3' }, { timeout: 20000 })
    const b64 = String(info?.base64 || '')
    if (b64) bytes = Buffer.from(b64, 'base64')
    seconds = Number(info?.duration ?? info?.length ?? 0) || 0
    if (info?.out_format) ext = String(info.out_format)
  } catch (error) {
    log?.('get_record 失败，改直接抓：' + (error?.message ?? error))
  }

  if (!bytes) {
    if (!url) return { error: '拿不到音频' }
    const got = await fetchBytes(url, { maxBytes: MAX_VOICE_BYTES })
    if (!got.ok) return { error: got.error }
    bytes = got.bytes
    const ct = String(got.contentType || '')
    if (ct.includes('silk') || ct.includes('octet')) ext = 'silk'
    else if (ct.includes('amr')) ext = 'amr'
    else if (ct.includes('wav')) ext = 'wav'
    else ext = 'mp3'
  }

  const path = join(d, Date.now() + '-voice.' + ext)
  try { writeFileSync(path, bytes) } catch (error) { return { error: '语音存不下去' } }
  return { ok: true, path, seconds, bytes: bytes.length, ext }
}

/** 合并转发：把里面每一条拉出来，压成缩进文本。深一层就够，别递归。 */
export async function expandForward(account, media, { log } = {}) {
  const id = String(media?.id || media?.resId || '')
  if (!id) return { error: '转发没给 id' }
  let data
  try {
    data = await account.client.call('get_forward_msg', { id }, { timeout: 20000 })
  } catch (error) {
    return { error: error?.message ?? String(error) }
  }
  const list = Array.isArray(data?.messages) ? data.messages : Array.isArray(data) ? data : []
  if (!list.length) return { error: '转发内容是空的' }
  const lines = []
  for (const node of list.slice(0, MAX_FORWARD_NODES)) {
    const sender = node?.sender?.nickname || node?.sender?.card || node?.nickname || '某人'
    const content = node?.content ?? node?.message ?? ''
    const text = typeof content === 'string' ? content : segmentsToPlain(content)
    lines.push(sender + '：' + text)
  }
  if (list.length > MAX_FORWARD_NODES) lines.push('…还有 ' + (list.length - MAX_FORWARD_NODES) + ' 条没展开')
  return { ok: true, text: lines.join('\n'), count: list.length }
}

/** 只压字，不认媒体：转发的正文里出现 [图片] 就够了。 */
function segmentsToPlain(message) {
  if (typeof message === 'string') return message
  if (!Array.isArray(message)) return ''
  const out = []
  for (const seg of message) {
    const t = seg?.type
    const d = seg?.data ?? {}
    if (t === 'text') out.push(String(d.text ?? ''))
    else if (t === 'image') out.push('[图片]')
    else if (t === 'record') out.push('[语音]')
    else if (t === 'face') out.push('[表情]')
    else if (t === 'mface') out.push('[表情包]')
    else if (t === 'video') out.push('[视频]')
    else if (t === 'at') out.push('@' + (d.name || d.qq || ''))
  }
  return out.join('')
}

/** 收藏表情列表。发之前先看一眼有哪些名字，别乱猜。 */
export async function listFaces(account, { count = 48 } = {}) {
  const data = await account.client.call('fetch_custom_face', { count }, { timeout: 20000 })
  const ids = Array.isArray(data) ? data : Array.isArray(data?.faceIds) ? data.faceIds : []
  return ids.map(String)
}
