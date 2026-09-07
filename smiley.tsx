/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import type { TuiPlugin, TuiPluginModule, TuiThemeCurrent } from "@opencode-ai/plugin/tui"

type RGBA = TuiThemeCurrent["primary"]

const PAD = "  "
const SEP = "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500"
const WAVE_W = 37

function waveDots(t: number): string {
  return Array.from({ length: WAVE_W }, (_, i) => {
    const v = Math.sin(i * 0.7 - t * 0.45)
    return v > 0.35 ? "\u25CF" : v > -0.35 ? "\u2022" : "\u00B7"
  }).join("")
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k"
  return String(n)
}

function fmtTps(n: number): string {
  if (n >= 100) return n.toFixed(0)
  if (n >= 10) return n.toFixed(1)
  return n.toFixed(2)
}

function fmtDur(ms: number): string {
  const s = ms / 1000
  if (s < 60) return s.toFixed(2) + "s"
  const m = Math.floor(s / 60)
  const r = (s % 60).toFixed(2)
  return m + "m " + r + "s"
}

function modelShort(modelID: string): string {
  const seg = (modelID.split("/").filter(Boolean).pop() || modelID).trim()
  return seg.length > 13 ? seg.slice(0, 12) + "\u2026" : seg
}

function shortCost(cost: number): string {
  return "$" + cost.toFixed(3)
}

const SPARKLINE_CHARS = "\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588"
const SPARKLINE_WIDTH = 10

interface ModelPoint {
  v: number
  m: string
  ok?: boolean
}

function hashStr(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
}

function sparklineBars(
  points: ModelPoint[],
  colorFor: (m: string) => RGBA,
  muted: RGBA,
): Array<{ ch: string; fg: RGBA }> {
  if (points.length === 0) return []
  const last = points.length > SPARKLINE_WIDTH ? points.slice(-SPARKLINE_WIDTH) : points
  const vals = last.filter((p) => p.ok !== false).map((p) => p.v)
  const min = vals.length ? Math.min(...vals) : 0
  const max = vals.length ? Math.max(...vals) : 1
  const range = max - min || 1
  const out: Array<{ ch: string; fg: RGBA }> = []
  for (const p of last) {
    if (p.ok === false) {
      out.push({ ch: " ", fg: muted })
      continue
    }
    const idx = Math.round(((p.v - min) / range) * (SPARKLINE_CHARS.length - 1))
    out.push({ ch: SPARKLINE_CHARS[idx], fg: colorFor(p.m) })
  }
  return out
}

interface FlatPart {
  type?: string
  text?: string
  time?: { start?: number; end?: number }
}

interface RawMessage {
  id?: string
  role: string
  modelID?: string
  providerID?: string
  cost?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
  time?: { created?: number; completed?: number }
}

interface ModelPricing {
  prompt?: string | number
  completion?: string | number
  input_cache_read?: string | number
  input_cache_write?: string | number
  inputPer1M?: number
  outputPer1M?: number
  cacheReadPer1M?: number
  cacheWritePer1M?: number
}

interface FileChange {
  additions?: number
  deletions?: number
}

interface MsgStats {
  input: number
  output: number
  thinking: number
  cached: number
  ctxUsed: number
  ctxLimit: number
  ctxPct: number
  cost: number
  genMs: number
  thinkMs: number
  outMs: number
  ttft: number | null
  tps: number
  thinkTps: number
  model: string
}

interface ModelRow {
  key: string
  name: string
  output: number
  cost: number
  count: number
  genSec: number
  avgTps: number
}

const pricing = new Map<string, ModelPricing>()
let pricingReady = false

async function loadPricing(api: Parameters<TuiPlugin>[0]): Promise<void> {
  try {
    const response = await fetch("https://api.surplusintelligence.ai/api/markets")
    if (response.ok) {
      const body = (await response.json()) as {
      markets?: Array<{
        model?: string
        best_input_per_1m?: number
        best_output_per_1m?: number
        best_cache_read_per_1m?: number
        best_cache_write_per_1m?: number
      }>
      }
      for (const market of body.markets || []) {
        if (!market.model || market.best_input_per_1m == null || market.best_output_per_1m == null) continue
        pricing.set(market.model, {
          inputPer1M: market.best_input_per_1m / 1_000_000,
          outputPer1M: market.best_output_per_1m / 1_000_000,
          cacheReadPer1M: (market.best_cache_read_per_1m ?? market.best_input_per_1m) / 1_000_000,
          cacheWritePer1M: (market.best_cache_write_per_1m ?? market.best_input_per_1m) / 1_000_000,
        })
      }
      pricingReady = true
      return
    }
  } catch {}

  try {
    const response = await fetch("https://api.surplusintelligence.ai/v1/models")
    if (!response.ok) return
    const body = (await response.json()) as { data?: Array<{ id?: string; pricing?: ModelPricing }> }
    for (const model of body.data || []) {
      if (model.id && model.pricing) pricing.set(model.id, model.pricing)
    }
    pricingReady = true
  } catch {}
}

function pricingCost(msg: RawMessage): number {
  const rates = pricing.get(msg.modelID || "")
  if (!rates || !msg.tokens) return msg.cost || 0
  const rate = (value: string | number | undefined) => Number(value || 0)
  const cache = msg.tokens.cache || {}
  if (rates.inputPer1M != null && rates.outputPer1M != null) {
    return (
      ((msg.tokens.input || 0) * rates.inputPer1M +
        (msg.tokens.output || 0) * rates.outputPer1M +
        (cache.read || 0) * (rates.cacheReadPer1M || 0) +
        (cache.write || 0) * (rates.cacheWritePer1M || 0)) /
      1_000_000
    )
  }
  return (
    (msg.tokens.input || 0) * rate(rates.prompt) +
    (msg.tokens.output || 0) * rate(rates.completion) +
    (cache.read || 0) * rate(rates.input_cache_read) +
    (cache.write || 0) * rate(rates.input_cache_write)
  )
}

function partList(api: Parameters<TuiPlugin>[0], messageID?: string): FlatPart[] {
  if (!messageID) return []
  try {
    return (api.state.part(messageID) || []) as FlatPart[]
  } catch {
    return []
  }
}

function thinkMsFor(parts: FlatPart[]): number {
  let n = 0
  for (const p of parts) {
    if (p.type === "reasoning" && p.time?.start && p.time?.end) {
      n += p.time.end - p.time.start
    }
  }
  return n
}

function thinkTokensFor(parts: FlatPart[]): number {
  let chars = 0
  for (const p of parts) {
    if (p.type === "reasoning" && p.text) chars += p.text.length
  }
  return chars > 0 ? Math.max(1, Math.round(chars / 4)) : 0
}

function msgStats(
  api: Parameters<TuiPlugin>[0],
  msg: RawMessage,
  parts: FlatPart[],
): MsgStats {
  const tk = msg.tokens || {}
  const input = tk.input || 0
  const output = tk.output || 0
  const thinking = tk.reasoning || 0
  const cached = (tk.cache?.read || 0) + (tk.cache?.write || 0)
  const ctxUsed = input + output + thinking + cached

  let ctxLimit = 0
  try {
    const prov = (api.state.provider || []).find((p) => p.id === msg.providerID)
    ctxLimit = (prov as any)?.models?.[msg.modelID || ""]?.limit?.context || 0
  } catch {}

  const thinkMs = thinkMsFor(parts)

  let ttft: number | null = null
  if (msg.time?.created) {
    for (const p of parts) {
      if ((p.type === "text" || p.type === "reasoning") && p.time?.start) {
        const d = p.time.start - msg.time.created
        if (d > 0) {
          ttft = d / 1000
          break
        }
      }
    }
  }

  let tps = 0
  if (msg.time?.created && msg.time?.completed) {
    const dur = (msg.time.completed - msg.time.created) / 1000
    if (dur > 0) tps = output / dur
  }

  const genMs =
    msg.time?.created && msg.time?.completed ? msg.time.completed - msg.time.created : 0

  const ttftMs = ttft !== null ? ttft * 1000 : 0
  const outMs = Math.max(0, genMs - thinkMs - ttftMs)

  const thinkTps = thinkMs > 0 ? Math.max(thinking, thinkTokensFor(parts)) / (thinkMs / 1000) : 0

  const ctxPct = ctxLimit > 0 ? Math.round((ctxUsed / ctxLimit) * 100) : 0

  return {
    input,
    output,
    thinking,
    cached,
    ctxUsed,
    ctxLimit,
    ctxPct,
    cost: pricingReady ? pricingCost(msg) : msg.cost || 0,
    genMs,
    thinkMs,
    outMs,
    ttft,
    tps,
    thinkTps,
    model: msg.modelID || "unknown",
  }
}

function computeStats(api: Parameters<TuiPlugin>[0], sessionID: string) {
  const msgs = (api.state.session.messages(sessionID) || []) as unknown as RawMessage[]
  const assistants = msgs.filter(
    (m) => m.role === "assistant" && m.tokens && (m.tokens.output || 0) > 0,
  )
  if (assistants.length === 0) return null

  const last = assistants[assistants.length - 1]
  const lastStats = msgStats(api, last, partList(api, last.id))

  let cost = 0
  let genMs = 0
  let thinkMs = 0
  let thinkTok = 0
  let ttftMs = 0
  let thinkCount = 0
  let msgCount = 0
  let totalOut = 0
  let totalGenSec = 0
  const perModel = new Map<string, ModelRow>()
  for (const m of assistants) {
    cost += pricingReady ? pricingCost(m) : m.cost || 0
    if (m.time?.created && m.time?.completed) genMs += m.time.completed - m.time.created
    const parts = partList(api, m.id)
    const tms = thinkMsFor(parts)
    thinkMs += tms
    thinkTok += Math.max(m.tokens?.reasoning || 0, thinkTokensFor(parts))
    if (tms > 0) thinkCount++
    msgCount++
    const out = m.tokens.output || 0
    totalOut += out
    const durSec =
      m.time?.created && m.time?.completed ? (m.time.completed - m.time.created) / 1000 : 0
    if (durSec > 0) totalGenSec += durSec
    if (m.time?.created) {
      for (const p of parts) {
        if ((p.type === "text" || p.type === "reasoning") && p.time?.start) {
          const d = p.time.start - m.time.created
          if (d > 0) {
            ttftMs += d
            break
          }
        }
      }
    }
    const key = m.modelID || "unknown"
    let row = perModel.get(key)
    if (!row) {
      row = { key, name: modelShort(key), output: 0, cost: 0, count: 0, genSec: 0, avgTps: 0 }
      perModel.set(key, row)
    }
    row.output += out
     row.cost += pricingReady ? pricingCost(m) : m.cost || 0
    row.count++
    row.genSec += durSec
  }
  const models = [...perModel.values()].sort((a, b) => b.cost - a.cost)
  for (const row of models) {
    row.avgTps = row.genSec > 0 ? row.output / row.genSec : 0
  }

  const speeds: ModelPoint[] = []
  const ttfts: ModelPoint[] = []
  for (const m of assistants.slice(-SPARKLINE_WIDTH)) {
    const model = m.modelID || "unknown"
    if (m.time?.created && m.time?.completed) {
      const dur = (m.time.completed - m.time.created) / 1000
      if (dur > 0) {
        speeds.push({ v: (m.tokens?.output || 0) / dur, m: model, ok: true })
      } else {
        speeds.push({ v: 0, m: model, ok: false })
      }
    } else {
      speeds.push({ v: 0, m: model, ok: false })
    }
    let t: number | null = null
    if (m.time?.created) {
      for (const p of partList(api, m.id)) {
        if ((p.type === "text" || p.type === "reasoning") && p.time?.start) {
          const d = p.time.start - m.time.created
          if (d > 0) {
            t = d / 1000
            break
          }
        }
      }
    }
    ttfts.push(t !== null ? { v: t, m: model, ok: true } : { v: 0, m: model, ok: false })
  }

  let add = 0
  let del = 0
  let files = 0
  try {
    const diff = (api.state.session.diff(sessionID) || []) as unknown as FileChange[]
    files = diff.length
    for (const f of diff) {
      add += f.additions || 0
      del += f.deletions || 0
    }
  } catch {}

  const outMs = Math.max(0, genMs - thinkMs - ttftMs)

  return {
    ...lastStats,
    cost,
    genMs,
    thinkMs,
    outMs,
    add,
    del,
    files,
    totalOut,
    msgCount,
    avgTps: totalGenSec > 0 ? totalOut / totalGenSec : 0,
    avgOutMs: msgCount > 0 ? outMs / msgCount : 0,
    avgThinkMs: thinkCount > 0 ? thinkMs / thinkCount : 0,
    avgThinkTps: thinkMs > 0 ? thinkTok / (thinkMs / 1000) : 0,
    avgTotalMs: msgCount > 0 ? genMs / msgCount : 0,
    hasThink: thinkCount > 0,
    speeds,
    ttfts,
    models,
    last: lastStats,
  }
}

function StatsView(props: { api: Parameters<TuiPlugin>[0]; sessionID: string }) {
  const t = () => props.api.theme.current
  const [tick, setTick] = createSignal(0)

  const modelColors = () => [
    t().primary,
    t().secondary,
    t().accent,
    t().success,
    t().warning,
    t().error,
    t().info,
    t().diffAdded,
    t().diffRemoved,
    t().syntaxString,
    t().syntaxNumber,
    t().syntaxFunction,
    t().syntaxKeyword,
    t().markdownHeading,
    t().markdownLink,
  ]
  const colorFor = (model: string): RGBA => {
    const colors = modelColors()
    return colors[hashStr(model) % colors.length]
  }

  const bump = (e: unknown) => {
    const ev = e as { properties?: { sessionID?: string } }
    if (!ev?.properties?.sessionID || ev.properties.sessionID === props.sessionID) {
      setTick((v) => v + 1)
    }
  }

  const stops = [
    props.api.event.on("message.updated", bump),
    props.api.event.on("message.part.updated", bump),
    props.api.event.on("session.idle", bump),
  ]
  onCleanup(() => stops.forEach((stop) => stop()))

  const isGenerating = createMemo(() => {
    tick()
    const msgs = (props.api.state.session.messages(props.sessionID) || []) as unknown as RawMessage[]
    const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant")
    if (!lastAssistant) return true
    const tk = lastAssistant.tokens
    return !tk || !tk.output
  })

  const stats = createMemo<ReturnType<typeof computeStats>>(() => {
    tick()
    try {
      return computeStats(props.api, props.sessionID)
    } catch {
      return null
    }
  })

  const [spin, setSpin] = createSignal(0)
  let timer: ReturnType<typeof setInterval> | undefined
  createEffect(() => {
    if (isGenerating()) {
      timer = setInterval(() => setSpin((f) => f + 1), 100)
    } else if (timer) {
      clearInterval(timer)
      timer = undefined
    }
  })
  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  return (
    <box flexDirection="column" paddingTop={1} paddingBottom={1}>
      <text style={{ fg: t().text, fontWeight: "bold" }}>{"\u263A"} Live Stats</text>
      <text style={{ fg: t().textMuted }}>
        {isGenerating() ? waveDots(spin()) : "\u00B7".repeat(WAVE_W)}
      </text>

      <Show
        when={stats()}
        fallback={<text style={{ fg: t().textMuted }}>{PAD}waiting...</text>}
      >
        {(s) => (
          <box flexDirection="column">
            <text style={{ fg: t().text, fontWeight: "bold" }}>{PAD}LAST RESPONSE</text>
            <box flexDirection="row" gap={1}>
              <text style={{ fg: t().textMuted }}>{PAD + "out".padEnd(5)}</text>
              <text style={{ fg: t().text }}>{fmtDur(s().last.outMs).padStart(8)}</text>
              <text style={{ fg: t().textMuted }}>{"\u00B7"}</text>
              <text style={{ fg: t().success }}>{fmtTps(s().last.tps) + " tok/s"}</text>
            </box>
            <box flexDirection="row" gap={1}>
              <text style={{ fg: t().textMuted }}>{PAD + "think".padEnd(5)}</text>
              <Show
                when={s().last.thinkMs > 0}
                fallback={<text style={{ fg: t().text }}>{"-".padStart(8)}</text>}
              >
                <text style={{ fg: t().text }}>{fmtDur(s().last.thinkMs).padStart(8)}</text>
              </Show>
              <text style={{ fg: t().textMuted }}>{"\u00B7"}</text>
              <Show
                when={s().last.thinkMs > 0}
                fallback={<text style={{ fg: t().textMuted }}>-</text>}
              >
                <text style={{ fg: t().warning }}>{fmtTps(s().last.thinkTps) + " tok/s"}</text>
              </Show>
            </box>
            <box flexDirection="row" gap={1}>
              <text style={{ fg: t().textMuted }}>{PAD + "ttft".padEnd(5)}</text>
              <text style={{ fg: t().text }}>
                {(s().last.ttft !== null ? s().last.ttft!.toFixed(2) + "s" : "0.00s").padStart(8)}
              </text>
            </box>
            <box flexDirection="row" gap={1}>
              <text style={{ fg: t().textMuted }}>{PAD + "total".padEnd(5)}</text>
              <text style={{ fg: t().text }}>{fmtDur(s().last.genMs).padStart(8)}</text>
            </box>
            <box flexDirection="row" gap={1}>
              <text style={{ fg: t().textMuted }}>{PAD + "model".padEnd(5)}</text>
              <text style={{ fg: colorFor(s().last.model) }}>{s().last.model}</text>
            </box>
            <text style={{ fg: t().textMuted }}>{PAD + SEP}</text>

            <text style={{ fg: t().text, fontWeight: "bold" }}>{PAD}BY MODEL</text>
            <box flexDirection="row">
              <text style={{ fg: t().textMuted }}>
                {PAD +
                  "model".padEnd(13) +
                  " " +
                  "out".padEnd(6) +
                  " " +
                  "t/s".padEnd(5) +
                  " " +
                  "$".padEnd(8)}
              </text>
            </box>
            <For each={s().models}>
              {(m) => (
                <box flexDirection="row">
                  <text style={{ fg: colorFor(m.key) }}>{PAD + m.name.padEnd(13) + " "}</text>
                  <text style={{ fg: t().text }}>
                    {fmt(m.output).padEnd(6) +
                      " " +
                      fmtTps(m.avgTps).padEnd(5) +
                      " " +
                      shortCost(m.cost).padEnd(8)}
                  </text>
                </box>
              )}
            </For>
            <box flexDirection="row">
              <text style={{ fg: t().text, fontWeight: "bold" }}>
                {PAD + "TOTALS".padEnd(13) + " "}
              </text>
              <text style={{ fg: t().text, fontWeight: "bold" }}>
                {fmt(s().totalOut).padEnd(6) +
                  " " +
                  fmtTps(s().avgTps).padEnd(5) +
                  " " +
                  shortCost(s().cost).padEnd(8)}
              </text>
            </box>
            <text style={{ fg: t().textMuted }}>{PAD + SEP}</text>

            <text style={{ fg: t().text, fontWeight: "bold" }}>{PAD}SESSION</text>
            <Show when={s().ctxLimit > 0}>
              <box flexDirection="row" gap={1}>
                <text style={{ fg: t().textMuted }}>{PAD + "ctx".padEnd(5)}</text>
                <text
                  style={{
                    fg:
                      s().ctxPct > 80
                        ? t().error
                        : s().ctxPct > 50
                          ? t().warning
                          : t().text,
                  }}
                >
                  {fmt(s().ctxUsed) + " / " + fmt(s().ctxLimit) + " (" + s().ctxPct + "%)"}
                </text>
              </box>
            </Show>
            <Show when={s().files > 0}>
              <box flexDirection="row" gap={1}>
                <text style={{ fg: t().textMuted }}>{PAD + "files".padEnd(5)}</text>
                <text style={{ fg: t().text }}>
                  {"+" + s().add + " -" + s().del + " (" + s().files + ")"}
                </text>
              </box>
            </Show>
            <box flexDirection="row" gap={1}>
              <text style={{ fg: t().textMuted }}>{PAD + "msg".padEnd(5)}</text>
              <text style={{ fg: t().text }}>{String(s().msgCount)}</text>
            </box>
            <box flexDirection="row" gap={1}>
              <text style={{ fg: t().textMuted }}>{PAD + "avg out".padEnd(9)}</text>
              <text style={{ fg: t().text }}>{fmtDur(s().avgOutMs).padStart(8)}</text>
              <text style={{ fg: t().textMuted }}>{"\u00B7"}</text>
              <text style={{ fg: t().success }}>{fmtTps(s().avgTps) + " tok/s"}</text>
            </box>
            <box flexDirection="row" gap={1}>
              <text style={{ fg: t().textMuted }}>{PAD + "avg think".padEnd(9)}</text>
              <Show
                when={s().hasThink}
                fallback={<text style={{ fg: t().text }}>{"-".padStart(8)}</text>}
              >
                <text style={{ fg: t().text }}>{fmtDur(s().avgThinkMs).padStart(8)}</text>
              </Show>
              <Show when={s().hasThink}>
                <text style={{ fg: t().textMuted }}>{"\u00B7"}</text>
                <text style={{ fg: t().warning }}>{fmtTps(s().avgThinkTps) + " tok/s"}</text>
              </Show>
            </box>
            <box flexDirection="row" gap={1}>
              <text style={{ fg: t().textMuted }}>{PAD + "avg total".padEnd(9)}</text>
              <text style={{ fg: t().text }}>{fmtDur(s().avgTotalMs).padStart(8)}</text>
            </box>
            <text> </text>
            <Show when={s().speeds.length >= 1}>
              <box flexDirection="row" gap={1}>
                <text style={{ fg: t().textMuted }}>{PAD + "tok/s"}</text>
                <box flexDirection="row">
                  <For each={sparklineBars(s().speeds, colorFor, t().textMuted)}>
                    {(b) => <text style={{ fg: b.fg }}>{b.ch}</text>}
                  </For>
                </box>
              </box>
            </Show>
            <text> </text>
            <Show when={s().ttfts.length >= 1}>
              <box flexDirection="row" gap={1}>
                <text style={{ fg: t().textMuted }}>{PAD + "ttft".padEnd(5)}</text>
                <box flexDirection="row">
                  <For each={sparklineBars(s().ttfts, colorFor, t().textMuted)}>
                    {(b) => <text style={{ fg: b.fg }}>{b.ch}</text>}
                  </For>
                </box>
              </box>
            </Show>
          </box>
        )}
      </Show>
    </box>
  )
}

const toasted = new Set<string>()

const tui: TuiPlugin = async (api) => {
  void loadPricing(api)
  api.slots.register({
    order: 10,
    slots: {
      sidebar_content(_ctx, props: { session_id: string }) {
        return <StatsView api={api} sessionID={props.session_id} />
      },
    },
  })

  const mayToast = (_ev: unknown) => {
    if (typeof api.ui?.toast !== "function") return
    try {
      const ev = _ev as { properties?: { sessionID?: string; messageID?: string } }
      const sid = ev?.properties?.sessionID || ""
      const mid = ev?.properties?.messageID
      if (!sid || !mid || toasted.has(mid)) return
      const msgs = (api.state.session.messages(sid) || []) as unknown as RawMessage[]
      const msg = msgs.find((m) => m.id === mid)
      if (!msg || msg.role !== "assistant") return
      const stats = msgStats(api, msg, partList(api, mid))
      if (stats.output <= 0 || stats.genMs <= 0) return
      toasted.add(mid)
      const parts: string[] = [
        "out " + fmt(stats.output),
        fmtTps(stats.tps) + " tok/s",
        shortCost(stats.cost),
      ]
      if (stats.ttft !== null) parts.push("ttft " + stats.ttft.toFixed(2) + "s")
      api.ui.toast({
        variant: "info",
        title: "Live Stats",
        message: parts.join(" \u00B7 "),
        duration: 6000,
      })
    } catch {}
  }

  const stops = [
    api.event.on("message.updated", mayToast),
    api.event.on("message.part.updated", mayToast),
  ]
  api.lifecycle.onDispose(() => stops.forEach((stop) => stop()))
}

const plugin: TuiPluginModule = { id: "live-stats", tui }

export default plugin
