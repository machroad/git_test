/**
 * 1인칭 / 3인칭 카메라.
 *
 * 두 모드가 yaw / pitch 를 공유하므로 전환해도 보던 방향이 유지된다.
 * 전환할 때마다 시점이 튀면 미로에서 방향 감각을 잃는다.
 */
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { EYE_H } from '../shared/constants'
import { segmentBlocked, type Maze } from '../shared/maze'
import type { MazeScene } from './scene'

export type ViewMode = 'first' | 'third'

/**
 * 통로 폭이 CELL - WALL_T = 3.6 밖에 안 된다. 정통 3인칭처럼 캐릭터 정후방
 * 멀리에 카메라를 두면 거의 항상 뒤쪽 벽에 박혀서, 화면이 캐릭터 등판으로 꽉 찬다.
 *
 * 그래서 어깨너머(over-the-shoulder) 방식을 쓴다. 카메라를 옆으로 살짝 밀고
 * 시선을 캐릭터보다 앞에 두면, 캐릭터는 화면 한쪽에 작게 남고 통로가 보인다.
 * 좁은 실내에서 3인칭을 성립시키는 일반적인 해법이다.
 */
const THIRD_DISTANCE = 3.8
const THIRD_SHOULDER = 0.95
const THIRD_PIVOT_H = EYE_H + 0.45
/** 시선을 캐릭터보다 이만큼 앞에 둬서 캐릭터를 화면 중앙에서 비켜나게 한다. */
const THIRD_LOOK_AHEAD = 2.2
/** 벽에 막혔을 때 오프셋을 이 비율까지 줄인다. 더 줄이면 1인칭과 다를 게 없다. */
const THIRD_MIN_SCALE = 0.32
const MIN_PITCH = -0.9
const MAX_PITCH = 1.1

export class CameraController {
  mode: ViewMode = 'third'
  yaw = 0
  pitch = 0.25

  setMode(mode: ViewMode): void {
    if (mode === this.mode) return
    this.mode = mode
    // 3인칭은 살짝 내려다보고, 1인칭은 수평이 기본이다.
    this.pitch = mode === 'third' ? Math.max(this.pitch, 0.15) : Math.min(this.pitch, 0.4)
  }

  rotate(deltaYaw: number, deltaPitch: number): void {
    this.yaw += deltaYaw
    this.pitch = Math.min(MAX_PITCH, Math.max(MIN_PITCH, this.pitch + deltaPitch))
  }

  /** WASD 입력을 카메라 기준에서 월드 방향으로 바꾼다. */
  toWorldDirection(forward: number, strafe: number): { dx: number; dz: number } {
    const sin = Math.sin(this.yaw)
    const cos = Math.cos(this.yaw)
    let dx = sin * forward + cos * strafe
    let dz = cos * forward - sin * strafe
    const len = Math.hypot(dx, dz)
    if (len > 1) {
      dx /= len
      dz /= len
    }
    return { dx, dz }
  }

  update(view: MazeScene, maze: Maze, playerX: number, playerZ: number): void {
    const camera = view.camera

    if (this.mode === 'first') {
      camera.position.set(playerX, EYE_H, playerZ)
      camera.rotation.set(this.pitch, this.yaw, 0)
      return
    }

    const sinYaw = Math.sin(this.yaw)
    const cosYaw = Math.cos(this.yaw)
    const cosPitch = Math.cos(this.pitch)

    // 뒤쪽 + 오른쪽 어깨 방향으로 합성한 오프셋.
    const offsetX = -sinYaw * THIRD_DISTANCE * cosPitch + cosYaw * THIRD_SHOULDER
    const offsetZ = -cosYaw * THIRD_DISTANCE * cosPitch - sinYaw * THIRD_SHOULDER
    const offsetY = Math.sin(this.pitch) * THIRD_DISTANCE

    const scale = this.clampOffset(maze, playerX, playerZ, offsetX, offsetZ)
    camera.position.set(
      playerX + offsetX * scale,
      THIRD_PIVOT_H + offsetY * scale,
      playerZ + offsetZ * scale,
    )
    camera.setTarget(
      new Vector3(
        playerX + sinYaw * THIRD_LOOK_AHEAD,
        EYE_H - Math.sin(this.pitch) * THIRD_LOOK_AHEAD,
        playerZ + cosYaw * THIRD_LOOK_AHEAD,
      ),
    )
  }

  /**
   * 카메라가 벽을 뚫고 나가지 않도록 오프셋을 줄인다. 0~1 배율을 돌려준다.
   *
   * 물리 레이캐스트 대신 미로 격자를 직접 훑는다. 메시에 의존하지 않아 더 싸고,
   * 보이는 벽과 판정이 항상 일치한다.
   */
  private clampOffset(maze: Maze, x: number, z: number, offsetX: number, offsetZ: number): number {
    const steps = 8
    for (let i = steps; i >= 1; i--) {
      const scale = i / steps
      if (scale < THIRD_MIN_SCALE) break
      if (!segmentBlocked(maze, x, z, x + offsetX * scale, z + offsetZ * scale)) return scale
    }
    return THIRD_MIN_SCALE
  }
}
