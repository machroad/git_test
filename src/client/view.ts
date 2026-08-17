/**
 * 화면 하나 = 플레이어 한 명.
 *
 * 게임 상태 / 렌더링 / 카메라 / 입력 / HUD 를 한데 묶는다.
 * 멀티뷰 테스트 모드에서는 이 객체가 여러 개 만들어지고, 각자 자기 클라이언트
 * 상태를 갖는다. 그래서 "호스트에서는 맞는데 클라에서는 틀린" 상황이 눈에 보인다.
 */
import type { ClientTransport } from '../net/transport'
import { cellToWorld } from '../shared/maze'
import { INTERACT_R } from '../shared/constants'
import { ITEMS, hasItem, torchRangeFor } from '../shared/items'
import { LOBBY_ENTRANCE_CELL, LOBBY_SHOP_CELL } from '../shared/sim'
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
  private goldEl: HTMLElement
  private shopEl: HTMLElement
  private barsEl: HTMLElement
  private hpFillEl: HTMLElement
  private staminaFillEl: HTMLElement
  private modeButtons: Record<ViewMode, HTMLButtonElement>
  private itemRows: { row: HTMLElement; button: HTMLButtonElement; itemId: number }[] = []
  private active = false
  private shopOpen = false
  private attackWasHeld = false
  private localSwingTimer = 0

  constructor(options: GameViewOptions) {
    this.label = options.label

    const dom = buildViewDom(options.label)
    options.container.appendChild(dom.root)
    this.root = dom.root
    this.statusEl = dom.statusEl
    this.centerEl = dom.centerEl
    this.crosshairEl = dom.crosshairEl
    this.goldEl = dom.goldEl
    this.shopEl = dom.shopEl
    this.barsEl = dom.barsEl
    this.hpFillEl = dom.hpFillEl
    this.staminaFillEl = dom.staminaFillEl
    this.modeButtons = dom.modeButtons
    this.itemRows = dom.itemRows

    for (const { button, itemId } of this.itemRows) {
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        this.state.buy(itemId)
      })
    }

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

    // 공격 이펙트는 호스트 응답을 기다리지 않고 누른 순간 보여준다.
    // 왕복 지연만큼 늦게 번쩍이면 조작이 씹힌 것처럼 느껴진다.
    const attackNow = this.input.attackHeld()
    if (attackNow && !this.attackWasHeld) this.localSwingTimer = 0.18
    this.attackWasHeld = attackNow
    this.localSwingTimer = Math.max(0, this.localSwingTimer - dt)
    // 전송과 예측은 update() 안의 고정 스텝에서 함께 일어난다.
    this.state.setInput(
      direction.dx,
      direction.dz,
      this.camera.yaw,
      this.input.interactHeld(),
      this.input.sprintHeld(),
      this.input.attackHeld(),
    )

    this.state.update(dt)

    const maze = this.state.maze
    if (!maze) {
      this.centerEl.textContent = '호스트에 연결하는 중...'
      return
    }

    const players = this.state.renderPlayers()
    const keys = this.state.renderKeys()
    const local = players.find((p) => p.isLocal)

    const inLobby = this.state.zone === 'lobby'
    const shopPos = inLobby ? cellToWorld(LOBBY_SHOP_CELL) : null
    const entrancePos = inLobby ? cellToWorld(LOBBY_ENTRANCE_CELL) : null

    this.scene.setLobbyMarkers(shopPos, entrancePos)
    this.scene.syncPlayers(players)
    const enemies = this.state.renderEnemies()
    this.scene.syncEnemies(enemies)
    this.scene.syncProjectiles(this.state.renderProjectiles())
    this.scene.syncKeys(keys, this.state.exitOpen, dt)
    if (local) {
      this.camera.update(this.scene, maze, local.x, local.z, dt)
      // 카메라가 아주 가까워지면 캐릭터가 화면을 다 가린다. 그럴 땐 감춘다.
      const tooClose = this.camera.distanceToPlayer() < 1.5
      this.scene.setLocalBodyVisible(
        local.id,
        this.camera.mode === 'third' && !local.escaped && !tooClose,
      )
      this.scene.setTorch(local.x, local.z, torchRangeFor(this.state.inventory))
      // 공격 범위 표시. 로비에서는 싸울 일이 없으므로 감춘다.
      this.scene.setAttackRange(
        local.x,
        local.z,
        this.camera.yaw,
        this.state.swinging || this.localSwingTimer > 0,
        this.state.zone === 'dungeon' && !local.escaped && !this.state.downed,
        dt,
      )
    }
    this.scene.render()

    this.minimap.inventory = this.state.inventory
    this.minimap.draw(
      maze,
      this.state.explored,
      players,
      keys,
      this.state.exitOpen,
      shopPos && entrancePos ? { shop: shopPos, entrance: entrancePos } : null,
      enemies,
    )
    this.updateShop(local, shopPos)
    this.updateHud(players.length, local, keys, entrancePos)
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

  /** 상점 근처에 있을 때만 구매 패널을 띄운다. */
  private updateShop(local: { x: number; z: number } | undefined, shopPos: { x: number; z: number } | null) {
    const near =
      !!local && !!shopPos && Math.hypot(local.x - shopPos.x, local.z - shopPos.z) <= INTERACT_R
    if (near !== this.shopOpen) {
      this.shopOpen = near
      this.shopEl.classList.toggle('is-open', near)
    }
    if (!near) return

    for (const { row, button, itemId } of this.itemRows) {
      const item = ITEMS.find((i) => i.id === itemId)!
      const owned = hasItem(this.state.inventory, item.id)
      const affordable = this.state.gold >= item.price
      row.classList.toggle('is-owned', owned)
      button.disabled = owned || !affordable
      button.textContent = owned ? '보유 중' : `${item.price} G`
    }
  }

  private updateHud(
    playerCount: number,
    local: { escaped: boolean } | undefined,
    keys: { collected: boolean }[],
    entrancePos: { x: number; z: number } | null,
  ) {
    const escaped = local?.escaped ?? false
    if (this.state.zone === 'lobby') {
      this.statusEl.textContent = `로비 · 인원 ${playerCount}`
    } else {
      const collected = keys.filter((k) => k.collected).length
      this.statusEl.textContent =
        `${this.state.levelIndex + 1}층 · 열쇠 ${collected}/${keys.length} · ` +
        `${this.state.exitOpen ? '탈출구 열림' : '탈출구 잠김'} · 인원 ${playerCount}`
    }
    this.goldEl.textContent = `${this.state.gold} G`

    // 체력 · 스태미나 게이지. 폭만 바꾸면 되므로 매 프레임 갱신해도 부담이 없다.
    this.hpFillEl.style.width = `${Math.max(0, Math.min(1, this.state.hpRatio)) * 100}%`
    this.staminaFillEl.style.width = `${Math.max(0, Math.min(1, this.state.staminaRatio)) * 100}%`
    // 경직 중에는 스태미나 바를 붉게 해서 왜 안 움직이는지 알려준다.
    this.staminaFillEl.classList.toggle('is-exhausted', this.state.stunned)
    this.barsEl.classList.toggle('is-downed', this.state.downed)

    const localPos = this.state.renderPosition()
    const nearEntrance =
      !!entrancePos &&
      Math.hypot(localPos.x - entrancePos.x, localPos.z - entrancePos.z) <= INTERACT_R

    if (this.state.downed) {
      this.centerEl.textContent = '쓰러졌다 — 잠시 후 부활합니다'
    } else if (this.state.stunned) {
      this.centerEl.textContent = '지쳤다! 숨을 고르는 중...'
    } else if (this.state.cleared) {
      this.centerEl.textContent = '전원 탈출! 잠시 후 이동합니다...'
    } else if (escaped) {
      this.centerEl.textContent = '탈출 완료 — 남은 팀원을 기다리는 중'
    } else if (!this.active) {
      this.centerEl.textContent = '이 화면을 클릭하면 조작합니다'
    } else if (nearEntrance) {
      this.centerEl.textContent = 'F — 던전 입장'
    } else if (this.shopOpen) {
      this.centerEl.textContent = ''
    } else if (this.input.hasPointerLock()) {
      this.centerEl.textContent = ''
    } else if (this.input.canUsePointerLock()) {
      this.centerEl.textContent =
        '클릭하면 마우스로 시점을 돌립니다 · WASD 이동 · Shift 달리기 · Space 공격'
    } else {
      this.centerEl.textContent =
        '드래그해서 시점 회전 · WASD 이동 · Shift 달리기 · Space 공격 · V 시점 전환'
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
  goldEl: HTMLElement
  shopEl: HTMLElement
  barsEl: HTMLElement
  hpFillEl: HTMLElement
  staminaFillEl: HTMLElement
  modeButtons: Record<ViewMode, HTMLButtonElement>
  itemRows: { row: HTMLElement; button: HTMLButtonElement; itemId: number }[]
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

  const goldEl = document.createElement('div')
  goldEl.className = 'status status--gold'
  topLeft.appendChild(goldEl)

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

  // 하단 중앙: 체력 · 스태미나 게이지
  const barsEl = document.createElement('div')
  barsEl.className = 'bars'
  const hpBar = document.createElement('div')
  hpBar.className = 'bar bar--hp'
  const hpFillEl = document.createElement('div')
  hpFillEl.className = 'bar__fill'
  hpBar.appendChild(hpFillEl)
  const staminaBar = document.createElement('div')
  staminaBar.className = 'bar bar--stamina'
  const staminaFillEl = document.createElement('div')
  staminaFillEl.className = 'bar__fill'
  staminaBar.appendChild(staminaFillEl)
  barsEl.append(hpBar, staminaBar)
  hud.appendChild(barsEl)

  // 상점 패널. 상점 근처에 있을 때만 열린다.
  const shopEl = document.createElement('div')
  shopEl.className = 'shop'
  const shopTitle = document.createElement('div')
  shopTitle.className = 'shop__title'
  shopTitle.textContent = '상점'
  shopEl.appendChild(shopTitle)

  const itemRows: { row: HTMLElement; button: HTMLButtonElement; itemId: number }[] = []
  for (const item of ITEMS) {
    const row = document.createElement('div')
    row.className = 'shop__row'

    const info = document.createElement('div')
    info.className = 'shop__info'
    const name = document.createElement('div')
    name.className = 'shop__name'
    name.textContent = item.name
    const desc = document.createElement('div')
    desc.className = 'shop__desc'
    desc.textContent = item.description
    info.append(name, desc)

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'shop__buy'
    button.textContent = `${item.price} G`

    row.append(info, button)
    shopEl.appendChild(row)
    itemRows.push({ row, button, itemId: item.id })
  }
  hud.appendChild(shopEl)

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
    goldEl,
    shopEl,
    barsEl,
    hpFillEl,
    staminaFillEl,
    modeButtons: { first: firstButton, third: thirdButton },
    itemRows,
  }
}
