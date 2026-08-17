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
 * 통로 폭이 CELL - WALL_T = 4 밖에 안 된다. 정통 3인칭처럼 캐릭터 정후방
 * 멀리에 카메라를 두면 거의 항상 뒤쪽 벽에 박혀서, 화면이 캐릭터 등판으로 꽉 찬다.
 *
 * 그래서 어깨너머(over-the-shoulder) 방식을 쓴다. 카메라를 옆으로 살짝 밀고
 * 시선을 캐릭터보다 앞에 두면, 캐릭터는 화면 한쪽에 작게 남고 통로가 보인다.
 * 좁은 실내에서 3인칭을 성립시키는 일반적인 해법이다.
 */
const THIRD_DISTANCE = 3.4
const THIRD_SHOULDER = 0.95
const THIRD_PIVOT_H = EYE_H + 0.45
/** 시선을 캐릭터보다 이만큼 앞에 둬서 캐릭터를 화면 중앙에서 비켜나게 한다. */
const THIRD_LOOK_AHEAD = 2.2
/** 벽에 막혔을 때 오프셋을 이 비율까지 줄인다. 더 줄이면 1인칭과 다를 게 없다. */
const THIRD_MIN_SCALE = 0.32

/**
 * 벽 회피 거리를 시간에 따라 부드럽게 따라간다.
 *
 * 좁은 통로에서 제자리 회전하면 카메라가 옆벽을 훑고 지나가므로, 실제 여유 거리는
 * 회전 각도에 따라 급격히 변한다. 그 값을 그대로 쓰면 화면이 뚝뚝 끊긴다.
 *
 * 당길 때는 빠르게(느리면 벽을 뚫고 보인다), 놓을 때는 천천히(빠르면 튕겨 나온다).
 *
 * 벽이 두꺼워진 뒤로는 당기는 속도를 늦출 여유가 생겼다. 잠깐 넘어가봐야
 * 벽 "안"에 머무를 뿐 반대편이 비쳐 보이지 않기 때문이다 (넘어가는 깊이 2.2 < 두께 4).
 * scripts/camera-probe.mjs 로 재서 튀는 구간이 0회가 되는 값으로 잡았다.
 */
const PULL_IN_TAU = 0.28
const PUSH_OUT_TAU = 0.25

const MIN_PITCH = -0.9
const MAX_PITCH = 1.1

export class CameraController {
  mode: ViewMode = 'third'
  yaw = 0
  pitch = 0.25
  /** 벽 회피로 실제 적용 중인 오프셋 배율. 시간에 따라 목표값을 따라간다. */
  private distanceScale = 1
  /**
   * 계측용. scripts/camera-probe.mjs 가 회전 시 부드러움과 벽 뚫림을 재는 데 쓴다.
   * 이 값들 덕분에 THIRD_DISTANCE / PULL_IN_TAU 를 감이 아니라 숫자로 정할 수 있었다.
   */
  debugScale = 1
  debugOvershoot = 0

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

  update(view: MazeScene, maze: Maze, playerX: number, playerZ: number, dt: number): void {
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

    const target = this.clampOffset(maze, playerX, playerZ, offsetX, offsetZ)
    const tau = target < this.distanceScale ? PULL_IN_TAU : PUSH_OUT_TAU
    this.distanceScale += (target - this.distanceScale) * (1 - Math.exp(-dt / tau))
    const scale = this.distanceScale
    this.debugScale = scale
    const offsetLength = Math.hypot(offsetX, offsetZ)
    this.debugOvershoot = Math.max(0, (scale - target) * offsetLength)

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
    const blocked = (scale: number) =>
      segmentBlocked(maze, x, z, x + offsetX * scale, z + offsetZ * scale)

    if (!blocked(1)) return 1

    // 성긴 격자로 훑기만 하면 결과가 몇 개의 이산값으로 뭉쳐서, 회전할 때
    // 카메라 거리가 계단처럼 튄다. 대략의 구간을 찾은 뒤 이분 탐색으로 다듬어
    // 연속적인 값을 낸다.
    let low = THIRD_MIN_SCALE // 막혀 있다고 보는 쪽
    let high = 1 // 뚫려 있는지 확인해야 하는 쪽
    const coarse = 5
    for (let i = coarse - 1; i >= 1; i--) {
      const scale = THIRD_MIN_SCALE + ((1 - THIRD_MIN_SCALE) * i) / coarse
      if (!blocked(scale)) {
        low = scale
        break
      }
      high = scale
    }

    for (let i = 0; i < 6; i++) {
      const mid = (low + high) / 2
      if (blocked(mid)) high = mid
      else low = mid
    }
    return low
  }
}
