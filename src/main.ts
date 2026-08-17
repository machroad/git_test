/**
 * 엔트리 포인트.
 *
 * 기본은 "한 페이지 안에서 호스트 + 클라이언트를 모두 돌리는" 인프로세스 모드다.
 * 네트워크가 전혀 필요 없어서 Artifact 배포본이나 오프라인에서도 그대로 돌아간다.
 *
 * 쿼리 파라미터:
 *   ?views=1|2|4   같은 페이지에 클라이언트를 몇 개 띄울지 (기본 1)
 *   ?skipSetup=1   설정 화면을 건너뛰고 저장된 설정으로 바로 시작 (테스트용)
 *   ?ws=ws://호스트:포트   인프로세스 대신 실제 WebSocket 호스트에 붙는다
 *   ?lat=120&jitter=20&loss=0.05   인프로세스 전송에 주입할 네트워크 조건
 */
import './style.css'
import { CELL } from './shared/constants'
import { installBrowserCompat } from './client/compat'
import { debugSettings } from './client/debug-settings'
import { loadStoredConfig, showSetupScreen } from './client/setup-screen'
import type { RunConfig } from './shared/config'
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
      config: () => RunConfig
      /** 셀 크기. 테스트에서 셀 좌표를 월드 좌표로 바꿀 때 쓴다. */
      cell: number
    }
  }
}

// Babylon 엔진을 만들기 전에 실행해야 한다.
installBrowserCompat()

const params = new URLSearchParams(location.search)
const wsUrl = params.get('ws')
const skipSetup = params.get('skipSetup') === '1' || wsUrl !== null

let viewCount = clampViews(Number(params.get('views') ?? '1'))
let runConfig: RunConfig = loadStoredConfig()

const appRoot = document.getElementById('app')
if (!appRoot) throw new Error('#app 을 찾을 수 없습니다.')
const app: HTMLElement = appRoot

const views: GameView[] = []
let activeView: GameView | null = null
let hub: InProcessHub | null = null
let host: GameHost | null = null
// boot() 이 모듈 평가 중에 바로 실행되므로, 그 안에서 건드리는 모듈 상태는
// 반드시 호출보다 먼저 선언돼야 한다. 아래에 두면 TDZ 로 초기화가 통째로 실패한다.
let debugOutputs: {
  fps: HTMLOutputElement
  maze: HTMLOutputElement
  rooms: HTMLOutputElement
  keys: HTMLOutputElement
} | null = null
let debugStack: HTMLElement | null = null

boot().catch((error) => {
  // 부팅 중 예외는 화면이 까맣게만 남아 원인을 알기 어렵다. 눈에 보이게 띄운다.
  console.error('[boot] 초기화 실패', error)
  const banner = document.createElement('div')
  banner.className = 'boot-banner boot-banner--error'
  banner.textContent = `초기화 실패: ${error instanceof Error ? error.message : String(error)}`
  document.body.appendChild(banner)
})

async function boot() {
  // 설정 화면에서 레벨 구성과 테스트 화면 수를 정한 뒤에 호스트를 만든다.
  // WebSocket 으로 붙을 때는 설정을 호스트가 들고 있으므로 건너뛴다.
  if (!skipSetup) {
    const result = await showSetupScreen(viewCount)
    runConfig = result.config
    viewCount = result.viewCount
  }

  const stage = document.createElement('div')
  stage.className = `stage stage--${viewCount}`
  app.appendChild(stage)

  if (wsUrl) {
    await bootWebSocket(stage, wsUrl)
  } else {
    bootInProcess(stage)
  }

  if (views.length > 0) focusView(views[0])
  window.__game = {
    views,
    host: () => host,
    hub: () => hub,
    config: () => runConfig,
    cell: CELL,
  }
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

  host = new GameHost(hub.createHostTransport(), { seed: randomSeed(), config: runConfig })
  host.start()

  for (let i = 0; i < viewCount; i++) {
    addView(stage, hub.createClientTransport(), `P${i + 1}${i === 0 ? ' (호스트 겸용)' : ''}`)
  }

  buildDebugPanel()
  buildDebugToolsPanel()
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
  let fpsAccum = 0
  let fpsFrames = 0

  const frame = (now: number) => {
    const elapsed = (now - last) / 1000
    // 탭이 백그라운드에 있다가 돌아오면 dt 가 몇 초씩 튄다. 상한을 둔다.
    const dt = Math.min(0.1, elapsed)
    last = now
    for (const view of views) view.frame(dt)

    // FPS 는 매 프레임 갱신하면 숫자가 튀어서 읽을 수가 없다. 0.5초씩 모아서 평균낸다.
    // 클램프된 dt 가 아니라 실제 경과 시간으로 재야 한다. 프레임이 느릴 때
    // 클램프값을 쓰면 실제보다 높은 FPS 가 나온다.
    fpsAccum += elapsed
    fpsFrames++
    if (debugOutputs && fpsAccum >= 0.5) {
      debugOutputs.fps.textContent = String(Math.round(fpsFrames / fpsAccum))
      const maze = views[0]?.state.maze
      debugOutputs.maze.textContent = maze ? `${maze.w}x${maze.h}` : '-'
      debugOutputs.rooms.textContent = maze ? String(maze.rooms.length) : '-'
      debugOutputs.keys.textContent = maze ? String(maze.keys.length) : '-'
      fpsAccum = 0
      fpsFrames = 0
    }

    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

/**
 * 우상단 디버그 패널. 인프로세스 전송일 때만 의미가 있다.
 * 지연과 손실을 실시간으로 바꿔가며 보간과 예측 보정이 버티는지 눈으로 확인한다.
 */
/** 우상단 패널들을 세로로 쌓는 컨테이너. 패널 높이를 몰라도 겹치지 않는다. */
function panelStack(): HTMLElement {
  if (!debugStack) {
    debugStack = document.createElement('div')
    debugStack.className = 'debug-stack'
    document.body.appendChild(debugStack)
  }
  return debugStack
}

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
  panelStack().appendChild(panel)

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

/**
 * 네트워크 패널 아래에 붙는 디버그 패널.
 * 미니맵을 어떻게 보여줄지와 현재 프레임레이트를 다룬다.
 */
function buildDebugToolsPanel() {
  const panel = document.createElement('div')
  panel.className = 'debug debug--tools'
  panel.innerHTML = `
    <div class="debug__title">디버그</div>
    <label class="debug__check">
      <input type="checkbox" data-flag="minimapRevealAll"> 미니맵 전체 보기
    </label>
    <label class="debug__check">
      <input type="checkbox" data-flag="minimapExpanded"> 미니맵 크게 보기 <span class="debug__key">M</span>
    </label>
    <label class="debug__check">
      <input type="checkbox" data-flag="highlightRooms" checked> 방 강조 표시
    </label>
    <div class="debug__stats">
      <span>FPS <output data-out="fps">-</output></span>
      <span>미로 <output data-out="maze">-</output></span>
      <span>방 <output data-out="rooms">-</output></span>
      <span>열쇠 <output data-out="keys">-</output></span>
    </div>
  `
  panelStack().appendChild(panel)

  const checkboxes = panel.querySelectorAll<HTMLInputElement>('input[data-flag]')
  const syncChecks = () => {
    checkboxes.forEach((input) => {
      const flag = input.dataset.flag as keyof typeof debugSettings
      input.checked = debugSettings[flag]
    })
    applyMinimapExpanded()
  }

  checkboxes.forEach((input) => {
    input.addEventListener('change', () => {
      const flag = input.dataset.flag as keyof typeof debugSettings
      debugSettings[flag] = input.checked
      applyMinimapExpanded()
    })
  })

  // M 키로도 미니맵을 키웠다 줄인다. 조작 중에 마우스를 패널까지 옮기기 번거롭다.
  window.addEventListener('keydown', (event) => {
    if (event.code !== 'KeyM') return
    debugSettings.minimapExpanded = !debugSettings.minimapExpanded
    syncChecks()
  })

  debugOutputs = {
    fps: panel.querySelector('[data-out="fps"]') as HTMLOutputElement,
    maze: panel.querySelector('[data-out="maze"]') as HTMLOutputElement,
    rooms: panel.querySelector('[data-out="rooms"]') as HTMLOutputElement,
    keys: panel.querySelector('[data-out="keys"]') as HTMLOutputElement,
  }
  syncChecks()
}

function applyMinimapExpanded() {
  document.body.classList.toggle('minimap-expanded', debugSettings.minimapExpanded)
  // 캔버스 크기가 바뀌므로 다음 프레임에 다시 그려져야 한다. 미니맵은 매 프레임 그리므로
  // 별도 처리가 필요 없지만, 3D 뷰포트는 명시적으로 알려줘야 한다.
  for (const view of views) view.resize()
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
