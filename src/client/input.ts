/**
 * 키보드 + 마우스 입력.
 *
 * 시점 회전은 두 가지 경로를 지원한다.
 *
 *  1) Pointer Lock — 커서가 사라지고 무한히 돌릴 수 있는 정상적인 FPS 조작.
 *  2) 드래그 — 마우스 버튼을 누른 채 끌어서 회전.
 *
 * 2번이 필요한 이유는 Pointer Lock 이 항상 쓸 수 있는 게 아니기 때문이다.
 * 샌드박스된 iframe(Artifact 뷰어 등)은 permissions policy 로 pointer-lock 을
 * 막아버리고, 그러면 requestPointerLock() 이 거부되면서 시점이 아예 돌아가지 않는다.
 * 락을 못 얻으면 조용히 드래그 방식으로 넘어간다.
 *
 * 여러 뷰를 동시에 띄우는 테스트 모드가 있어서, 입력은 "지금 선택된 뷰"에만
 * 전달되어야 한다. 그래서 전역 리스너를 두고 enabled 플래그로 걸러낸다.
 */

export interface MoveIntent {
  /** 앞(+1) / 뒤(-1) */
  forward: number
  /** 오른쪽(+1) / 왼쪽(-1) */
  strafe: number
}

/** 시점 회전을 어떤 방식으로 하고 있는지. HUD 안내 문구를 바꾸는 데 쓴다. */
export type LookMode = 'pointer-lock' | 'drag'

const SCROLL_KEYS = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])

/** 마우스 이동 1px 당 회전량(라디안). */
const MOUSE_SENSITIVITY = 0.0025
/** 드래그는 커서를 놓칠 일이 없어 조금 더 크게 잡아야 답답하지 않다. */
const DRAG_SENSITIVITY = 0.004
/** Q / E 로 도는 속도(초당 라디안). 마우스가 불편할 때의 대안. */
const KEY_TURN_SPEED = 2.2

export class InputController {
  enabled = false

  /** 이번 프레임에 쌓인 회전량. 읽어가면 0으로 초기화된다. */
  private lookDeltaX = 0
  private lookDeltaY = 0
  private keys = new Set<string>()
  private canvas: HTMLCanvasElement
  private disposers: (() => void)[] = []
  private onToggleView?: () => void

  /** Pointer Lock 을 시도했다가 거부당했으면 다시 시도하지 않는다. */
  private pointerLockBlocked = false
  private dragging = false
  private dragPointerId: number | null = null
  private lastDragX = 0
  private lastDragY = 0

  constructor(canvas: HTMLCanvasElement, onToggleView?: () => void) {
    this.canvas = canvas
    this.onToggleView = onToggleView

    const keyDown = (event: KeyboardEvent) => {
      if (!this.enabled) return
      this.keys.add(event.code)
      if (event.code === 'KeyV') this.onToggleView?.()
      // 스페이스/화살표로 페이지가 스크롤되면 조작이 끊긴다.
      if (SCROLL_KEYS.has(event.code)) event.preventDefault()
    }
    const keyUp = (event: KeyboardEvent) => {
      this.keys.delete(event.code)
    }
    const blur = () => {
      this.keys.clear()
      this.endDrag()
    }

    // Pointer Lock 이 걸려 있을 때의 경로. movementX/Y 가 누적 회전량이 된다.
    const mouseMove = (event: MouseEvent) => {
      if (!this.enabled) return
      if (document.pointerLockElement !== this.canvas) return
      this.lookDeltaX += event.movementX * MOUSE_SENSITIVITY
      this.lookDeltaY += event.movementY * MOUSE_SENSITIVITY
    }

    // 드래그 경로. Pointer Lock 을 못 쓸 때 여기로 넘어온다.
    const pointerDown = (event: PointerEvent) => {
      if (!this.enabled) return
      if (event.button !== 0) return
      this.tryPointerLock()
      if (document.pointerLockElement === this.canvas) return

      this.dragging = true
      this.dragPointerId = event.pointerId
      this.lastDragX = event.clientX
      this.lastDragY = event.clientY
      this.canvas.setPointerCapture(event.pointerId)
      this.canvas.classList.add('is-dragging')
      // 드래그 중 텍스트 선택이 되면 커서가 이상하게 잡힌다.
      event.preventDefault()
    }

    const pointerMove = (event: PointerEvent) => {
      if (!this.dragging || event.pointerId !== this.dragPointerId) return
      // movementX 는 브라우저마다 편차가 있어 직접 계산한다.
      this.lookDeltaX += (event.clientX - this.lastDragX) * DRAG_SENSITIVITY
      this.lookDeltaY += (event.clientY - this.lastDragY) * DRAG_SENSITIVITY
      this.lastDragX = event.clientX
      this.lastDragY = event.clientY
    }

    const pointerUp = (event: PointerEvent) => {
      if (event.pointerId !== this.dragPointerId) return
      this.endDrag()
    }

    const lockError = () => {
      // Pointer Lock 이 거부됐다. 드래그로 계속 진행한다.
      this.pointerLockBlocked = true
    }

    // requestPointerLock 은 비동기라, 호출 직후에는 아직 락이 안 걸려 있다.
    // 그래서 첫 클릭은 일단 드래그로 시작하는데, 잠시 뒤 락이 실제로 걸리면
    // 드래그와 movementX 가 동시에 쌓여 시점이 두 배로 돈다. 락이 잡히는 순간 드래그를 끝낸다.
    const lockChange = () => {
      if (document.pointerLockElement === this.canvas) this.endDrag()
    }

    window.addEventListener('keydown', keyDown)
    window.addEventListener('keyup', keyUp)
    window.addEventListener('blur', blur)
    window.addEventListener('mousemove', mouseMove)
    canvas.addEventListener('pointerdown', pointerDown)
    canvas.addEventListener('pointermove', pointerMove)
    canvas.addEventListener('pointerup', pointerUp)
    canvas.addEventListener('pointercancel', pointerUp)
    document.addEventListener('pointerlockerror', lockError)
    document.addEventListener('pointerlockchange', lockChange)

    this.disposers.push(() => {
      window.removeEventListener('keydown', keyDown)
      window.removeEventListener('keyup', keyUp)
      window.removeEventListener('blur', blur)
      window.removeEventListener('mousemove', mouseMove)
      canvas.removeEventListener('pointerdown', pointerDown)
      canvas.removeEventListener('pointermove', pointerMove)
      canvas.removeEventListener('pointerup', pointerUp)
      canvas.removeEventListener('pointercancel', pointerUp)
      document.removeEventListener('pointerlockerror', lockError)
      document.removeEventListener('pointerlockchange', lockChange)
    })
  }

  /** 상호작용 키(F)가 눌려 있는지. 눌린 "순간" 판정은 시뮬레이션 쪽에서 한다. */
  interactHeld(): boolean {
    return this.enabled && this.keys.has('KeyF')
  }

  moveIntent(): MoveIntent {
    if (!this.enabled) return { forward: 0, strafe: 0 }
    let forward = 0
    let strafe = 0
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) forward += 1
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) forward -= 1
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) strafe += 1
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) strafe -= 1
    return { forward, strafe }
  }

  /**
   * 누적된 회전량을 읽고 비운다. dt 는 키보드 회전(Q/E)에 쓰인다.
   * 마우스 입력은 이미 이동량 자체가 회전량이므로 dt 를 곱하지 않는다.
   */
  consumeLook(dt: number): { yaw: number; pitch: number } {
    let yaw = this.lookDeltaX
    const pitch = this.lookDeltaY
    this.lookDeltaX = 0
    this.lookDeltaY = 0

    if (this.enabled) {
      if (this.keys.has('KeyQ')) yaw -= KEY_TURN_SPEED * dt
      if (this.keys.has('KeyE')) yaw += KEY_TURN_SPEED * dt
    }

    return { yaw, pitch }
  }

  /** 지금 어떤 방식으로 시점을 돌리고 있는지. */
  lookMode(): LookMode {
    return document.pointerLockElement === this.canvas ? 'pointer-lock' : 'drag'
  }

  /** Pointer Lock 을 쓸 수 있는 환경인지. 거부당한 적이 있으면 false. */
  canUsePointerLock(): boolean {
    return !this.pointerLockBlocked
  }

  hasPointerLock(): boolean {
    return document.pointerLockElement === this.canvas
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) {
      this.keys.clear()
      this.endDrag()
      if (document.pointerLockElement === this.canvas) document.exitPointerLock()
    }
  }

  dispose(): void {
    this.endDrag()
    for (const dispose of this.disposers) dispose()
    this.disposers = []
  }

  private tryPointerLock() {
    if (this.pointerLockBlocked) return
    if (document.pointerLockElement === this.canvas) return
    if (typeof this.canvas.requestPointerLock !== 'function') {
      this.pointerLockBlocked = true
      return
    }

    try {
      // 최신 브라우저는 Promise 를 돌려주고, 구형은 undefined 를 돌려준 뒤
      // 실패 시 pointerlockerror 이벤트를 쏜다. 양쪽 다 처리한다.
      const result = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined
      if (result && typeof result.catch === 'function') {
        result.catch(() => {
          this.pointerLockBlocked = true
        })
      }
    } catch {
      this.pointerLockBlocked = true
    }
  }

  private endDrag() {
    if (!this.dragging) return
    if (this.dragPointerId !== null && this.canvas.hasPointerCapture(this.dragPointerId)) {
      this.canvas.releasePointerCapture(this.dragPointerId)
    }
    this.dragging = false
    this.dragPointerId = null
    this.canvas.classList.remove('is-dragging')
  }
}
