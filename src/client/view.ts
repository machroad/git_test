/**
 * 화면 하나 = 플레이어 한 명.
 *
 * 게임 상태 / 렌더링 / 카메라 / 입력 / HUD 를 한데 묶는다.
 * 멀티뷰 테스트 모드에서는 이 객체가 여러 개 만들어지고, 각자 자기 클라이언트
 * 상태를 갖는다. 그래서 "호스트에서는 맞는데 클라에서는 틀린" 상황이 눈에 보인다.
 */
import type { ClientTransport } from '../net/transport'
import { GameClientState } from '../game/client-state'
import { CameraController, type ViewMode } from './camera'
import { InputController } from './input'
import { Minimap } from './minimap'
import { MazeScene } from './scene'

export interface GameViewOptions {
  container: HTMLElement
  transport: ClientTransport
  label: string
  /** 이 뷰가 조작 대상으로 선택됐을 때 호출된다. */
  onFocus: (view: GameView) => void
}

export class GameView {
  readonly state: GameClientState
  readonly camera = new CameraController()
  readonly label: string

  /** 렌더러. 스모크 테스트에서 Babylon 씬에 직접 접근하기 위해 공개해 둔다. */
  readonly scene: MazeScene

  private input: InputController
  private minimap: Minimap
  private root: HTMLElement
  private statusEl: HTMLElement
  private centerEl: HTMLElement
  private crosshairEl: HTMLElement
  private modeButtons: Record<ViewMode, HTMLButtonElement>
  private active = false

  constructor(options: GameViewOptions) {
    this.label = options.label

    const dom = buildViewDom(options.label)
    options.container.appendChild(dom.root)
    this.root = dom.root
    this.statusEl = dom.statusEl
    this.centerEl = dom.centerEl
    this.crosshairEl = dom.crosshairEl
    this.modeButtons = dom.modeButtons

    this.scene = new MazeScene(dom.sceneCanvas)
    this.minimap = new Minimap(dom.minimapCanvas)
    this.state = new GameClientState(options.transport, (maze) => this.scene.buildMaze(maze))
    this.input = new InputController(dom.sceneCanvas, () => this.toggleMode())

    for (const mode of ['first', 'third'] as ViewMode[]) {
      this.modeButtons[mode].addEventListener('click', (event) => {
        event.stopPropagation()
        this.setMode(mode)
      })
    }

    dom.root.addEventListener('pointerdown', () => options.onFocus(this))
    this.setMode('third')
  }

  setActive(active: boolean): void {
    this.active = active
    this.input.setEnabled(active)
    this.root.classList.toggle('is-active', active)
  }

  setMode(mode: ViewMode): void {
    this.camera.setMode(mode)
    this.modeButtons.first.classList.toggle('is-on', mode === 'first')
    this.modeButtons.third.classList.toggle('is-on', mode === 'third')
    // 1인칭은 화면 중앙에 기준점이 없으면 어디를 보고 있는지 감이 안 온다.
    this.crosshairEl.classList.toggle('is-on', mode === 'first')
  }

  toggleMode(): void {
    this.setMode(this.camera.mode === 'first' ? 'third' : 'first')
  }

  /** 매 프레임 호출. dt 는 초 단위. */
  frame(dt: number): void {
    const look = this.input.consumeLook(dt)
    if (look.yaw !== 0 || look.pitch !== 0) this.camera.rotate(look.yaw, look.pitch)

    const intent = this.input.moveIntent()
    const direction = this.camera.toWorldDirection(intent.forward, intent.strafe)
    // 전송과 예측은 update() 안의 고정 스텝에서 함께 일어난다.
    this.state.setInput(direction.dx, direction.dz, this.camera.yaw)

    this.state.update(dt)

    const maze = this.state.maze
    if (!maze) {
      this.centerEl.textContent = '호스트에 연결하는 중...'
      return
    }

    const players = this.state.renderPlayers()
    const keys = this.state.renderKeys()
    const local = players.find((p) => p.isLocal)

    this.scene.syncPlayers(players)
    this.scene.syncKeys(keys, this.state.exitOpen, dt)
    if (local) {
      this.scene.setLocalBodyVisible(local.id, this.camera.mode === 'third' && !local.escaped)
      this.camera.update(this.scene, maze, local.x, local.z, dt)
      this.scene.setTorch(local.x, local.z)
    }
    this.scene.render()

    this.minimap.draw(maze, this.state.explored, players, keys, this.state.exitOpen)
    this.updateHud(players.length, local?.escaped ?? false, keys)
  }

  resize(): void {
    this.scene.resize()
  }

  dispose(): void {
    this.input.dispose()
    this.state.dispose()
    this.scene.dispose()
    this.root.remove()
  }

  private updateHud(playerCount: number, escaped: boolean, keys: { collected: boolean }[]) {
    const collected = keys.filter((k) => k.collected).length
    this.statusEl.textContent =
      `레벨 ${this.state.level} · 열쇠 ${collected}/${keys.length} · ` +
      `${this.state.exitOpen ? '탈출구 열림' : '탈출구 잠김'} · 인원 ${playerCount}`

    if (this.state.cleared) {
      this.centerEl.textContent = '전원 탈출! 다음 레벨로 이동합니다...'
    } else if (escaped) {
      this.centerEl.textContent = '탈출 완료 — 남은 팀원을 기다리는 중'
    } else if (!this.active) {
      this.centerEl.textContent = '이 화면을 클릭하면 조작합니다'
    } else if (this.input.hasPointerLock()) {
      this.centerEl.textContent = ''
    } else if (this.input.canUsePointerLock()) {
      this.centerEl.textContent = '클릭하면 마우스로 시점을 돌립니다 · WASD 이동 · V 시점 전환'
    } else {
      // Pointer Lock 이 막힌 환경(샌드박스 iframe 등). 드래그 조작을 안내한다.
      this.centerEl.textContent = '드래그해서 시점 회전 · WASD 이동 · Q/E 좌우 회전 · V 시점 전환'
    }
  }
}

interface ViewDom {
  root: HTMLElement
  sceneCanvas: HTMLCanvasElement
  minimapCanvas: HTMLCanvasElement
  statusEl: HTMLElement
  centerEl: HTMLElement
  crosshairEl: HTMLElement
  modeButtons: Record<ViewMode, HTMLButtonElement>
}

function buildViewDom(label: string): ViewDom {
  const root = document.createElement('div')
  root.className = 'view'

  const sceneCanvas = document.createElement('canvas')
  sceneCanvas.className = 'view__scene'
  root.appendChild(sceneCanvas)

  const hud = document.createElement('div')
  hud.className = 'hud'
  root.appendChild(hud)

  // 좌상단: 시점 선택
  const topLeft = document.createElement('div')
  topLeft.className = 'hud__topleft'
  hud.appendChild(topLeft)

  const switcher = document.createElement('div')
  switcher.className = 'switcher'
  topLeft.appendChild(switcher)

  const firstButton = document.createElement('button')
  firstButton.type = 'button'
  firstButton.textContent = '1인칭'
  const thirdButton = document.createElement('button')
  thirdButton.type = 'button'
  thirdButton.textContent = '3인칭'
  switcher.append(firstButton, thirdButton)

  const statusEl = document.createElement('div')
  statusEl.className = 'status'
  topLeft.appendChild(statusEl)

  const labelEl = document.createElement('div')
  labelEl.className = 'view__label'
  labelEl.textContent = label
  hud.appendChild(labelEl)

  const centerEl = document.createElement('div')
  centerEl.className = 'hud__center'
  hud.appendChild(centerEl)

  const crosshairEl = document.createElement('div')
  crosshairEl.className = 'hud__crosshair'
  hud.appendChild(crosshairEl)

  // 우하단: 미니맵
  const minimapWrap = document.createElement('div')
  minimapWrap.className = 'hud__minimap'
  const minimapCanvas = document.createElement('canvas')
  minimapWrap.appendChild(minimapCanvas)
  hud.appendChild(minimapWrap)

  return {
    root,
    sceneCanvas,
    minimapCanvas,
    statusEl,
    centerEl,
    crosshairEl,
    modeButtons: { first: firstButton, third: thirdButton },
  }
}
