/**
 * 키보드 + 마우스 입력.
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

export class InputController {
  enabled = false
  /** 이번 프레임에 쌓인 마우스 이동량. 읽어가면 0으로 초기화된다. */
  private mouseDeltaX = 0
  private mouseDeltaY = 0
  private keys = new Set<string>()
  private canvas: HTMLCanvasElement
  private disposers: (() => void)[] = []
  private onToggleView?: () => void

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
    const blur = () => this.keys.clear()

    const mouseMove = (event: MouseEvent) => {
      if (!this.enabled) return
      if (document.pointerLockElement !== this.canvas) return
      this.mouseDeltaX += event.movementX
      this.mouseDeltaY += event.movementY
    }

    const requestLock = () => {
      if (!this.enabled) return
      if (document.pointerLockElement === this.canvas) return
      void this.canvas.requestPointerLock()
    }

    window.addEventListener('keydown', keyDown)
    window.addEventListener('keyup', keyUp)
    window.addEventListener('blur', blur)
    window.addEventListener('mousemove', mouseMove)
    canvas.addEventListener('click', requestLock)

    this.disposers.push(() => {
      window.removeEventListener('keydown', keyDown)
      window.removeEventListener('keyup', keyUp)
      window.removeEventListener('blur', blur)
      window.removeEventListener('mousemove', mouseMove)
      canvas.removeEventListener('click', requestLock)
    })
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

  /** 누적된 마우스 이동량을 읽고 비운다. */
  consumeLook(): { yaw: number; pitch: number } {
    const sensitivity = 0.0025
    const yaw = this.mouseDeltaX * sensitivity
    const pitch = this.mouseDeltaY * sensitivity
    this.mouseDeltaX = 0
    this.mouseDeltaY = 0
    return { yaw, pitch }
  }

  hasPointerLock(): boolean {
    return document.pointerLockElement === this.canvas
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) {
      this.keys.clear()
      if (document.pointerLockElement === this.canvas) document.exitPointerLock()
    }
  }

  dispose(): void {
    for (const dispose of this.disposers) dispose()
    this.disposers = []
  }
}

const SCROLL_KEYS = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])
