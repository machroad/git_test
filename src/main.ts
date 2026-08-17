/**
 * 엔트리 포인트.
 *
 * 기본은 "한 페이지 안에서 호스트 + 클라이언트를 모두 돌리는" 인프로세스 모드다.
 * 네트워크가 전혀 필요 없어서 Artifact 배포본이나 오프라인에서도 그대로 돌아간다.
 *
 * 쿼리 파라미터:
 *   ?views=1|2|4   같은 페이지에 클라이언트를 몇 개 띄울지 (기본 1)
 *   ?ws=ws://호스트:포트   인프로세스 대신 실제 WebSocket 호스트에 붙는다
 *   ?lat=120&jitter=20&loss=0.05   인프로세스 전송에 주입할 네트워크 조건
 */
import './style.css'
import { installBrowserCompat } from './client/compat'
import { GameHost } from './game/host'
import { InProcessHub } from './net/in-process'
import { connectWebSocket } from './net/websocket'
import type { ClientTransport } from './net/transport'
import { GameView } from './client/view'

declare global {
  interface Window {
    /** 헤드리스 스모크 테스트에서 내부 상태를 들여다보기 위한 훅. */
    __game?: {
      views: GameView[]
      host: () => GameHost | null
      hub: () => InProcessHub | null
    }
  }
}

// Babylon 엔진을 만들기 전에 실행해야 한다.
installBrowserCompat()

const params = new URLSearchParams(location.search)
const viewCount = clampViews(Number(params.get('views') ?? '1'))
const wsUrl = params.get('ws')

const appRoot = document.getElementById('app')
if (!appRoot) throw new Error('#app 을 찾을 수 없습니다.')
const app: HTMLElement = appRoot

const views: GameView[] = []
let activeView: GameView | null = null
let hub: InProcessHub | null = null
let host: GameHost | null = null

boot().catch((error) => {
  // 부팅 중 예외는 화면이 까맣게만 남아 원인을 알기 어렵다. 눈에 보이게 띄운다.
  console.error('[boot] 초기화 실패', error)
  const banner = document.createElement('div')
  banner.className = 'boot-banner boot-banner--error'
  banner.textContent = `초기화 실패: ${error instanceof Error ? error.message : String(error)}`
  document.body.appendChild(banner)
})

async function boot() {
  const stage = document.createElement('div')
  stage.className = `stage stage--${viewCount}`
  app.appendChild(stage)

  if (wsUrl) {
    await bootWebSocket(stage, wsUrl)
  } else {
    bootInProcess(stage)
  }

  if (views.length > 0) focusView(views[0])
  window.__game = { views, host: () => host, hub: () => hub }
  startRenderLoop()
  window.addEventListener('resize', () => {
    for (const view of views) view.resize()
  })
}

function bootInProcess(stage: HTMLElement) {
  hub = new InProcessHub({
    latencyMs: Number(params.get('lat') ?? '0'),
    jitterMs: Number(params.get('jitter') ?? '0'),
    loss: Number(params.get('loss') ?? '0'),
  })

  host = new GameHost(hub.createHostTransport(), { seed: randomSeed() })
  host.start()

  for (let i = 0; i < viewCount; i++) {
    addView(stage, hub.createClientTransport(), `P${i + 1}${i === 0 ? ' (호스트 겸용)' : ''}`)
  }

  buildDebugPanel()
}

async function bootWebSocket(stage: HTMLElement, url: string) {
  const banner = document.createElement('div')
  banner.className = 'boot-banner'
  banner.textContent = `${url} 에 연결하는 중...`
  app.appendChild(banner)

  try {
    const transport = await connectWebSocket(url)
    banner.remove()
    addView(stage, transport, 'P1')
  } catch (error) {
    banner.textContent =
      `${url} 연결 실패. 호스트에서 \`npm run server\` 가 돌고 있는지 확인하세요. ` +
      `(${error instanceof Error ? error.message : String(error)})`
    banner.classList.add('boot-banner--error')
  }
}

function addView(stage: HTMLElement, transport: ClientTransport, label: string) {
  const view = new GameView({
    container: stage,
    transport,
    label,
    onFocus: (target) => focusView(target),
  })
  view.state.setName(label)
  views.push(view)
}

function focusView(view: GameView) {
  if (activeView === view) return
  activeView = view
  for (const candidate of views) candidate.setActive(candidate === view)
}

function startRenderLoop() {
  let last = performance.now()
  const frame = (now: number) => {
    // 탭이 백그라운드에 있다가 돌아오면 dt 가 몇 초씩 튄다. 상한을 둔다.
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    for (const view of views) view.frame(dt)
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

/**
 * 우상단 디버그 패널. 인프로세스 전송일 때만 의미가 있다.
 * 지연과 손실을 실시간으로 바꿔가며 보간과 예측 보정이 버티는지 눈으로 확인한다.
 */
function buildDebugPanel() {
  if (!hub) return
  const panel = document.createElement('div')
  panel.className = 'debug'
  panel.innerHTML = `
    <div class="debug__title">네트워크 시뮬레이션</div>
    <label>지연 <output data-out="lat">0</output>ms
      <input type="range" data-net="latencyMs" min="0" max="400" step="10" value="${hub.net.latencyMs}">
    </label>
    <label>지터 <output data-out="jitter">0</output>ms
      <input type="range" data-net="jitterMs" min="0" max="150" step="5" value="${hub.net.jitterMs}">
    </label>
    <label>손실 <output data-out="loss">0</output>%
      <input type="range" data-net="loss" min="0" max="40" step="1" value="${hub.net.loss * 100}">
    </label>
    <div class="debug__views">
      화면 <a href="?views=1">1</a> · <a href="?views=2">2</a> · <a href="?views=4">4</a>
    </div>
  `
  document.body.appendChild(panel)

  const outputs = {
    lat: panel.querySelector('[data-out="lat"]') as HTMLOutputElement,
    jitter: panel.querySelector('[data-out="jitter"]') as HTMLOutputElement,
    loss: panel.querySelector('[data-out="loss"]') as HTMLOutputElement,
  }

  const sync = () => {
    if (!hub) return
    outputs.lat.textContent = String(hub.net.latencyMs)
    outputs.jitter.textContent = String(hub.net.jitterMs)
    outputs.loss.textContent = (hub.net.loss * 100).toFixed(0)
  }

  panel.querySelectorAll<HTMLInputElement>('input[data-net]').forEach((input) => {
    input.addEventListener('input', () => {
      if (!hub) return
      const field = input.dataset.net as 'latencyMs' | 'jitterMs' | 'loss'
      const value = Number(input.value)
      hub.setConditions({ [field]: field === 'loss' ? value / 100 : value })
      sync()
    })
  })
  sync()
}

function clampViews(value: number): number {
  if (value === 2) return 2
  if (value === 4) return 4
  return 1
}

function randomSeed(): number {
  // 시드 자체는 매 판 달라도 되지만, 한번 정해지면 모두가 같은 값을 쓴다.
  return (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1
}
