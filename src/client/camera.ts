/**
 * 1인칭 / 3인칭 카메라.
 *
 * 두 모드가 yaw / pitch 를 공유하므로 전환해도 보던 방향이 유지된다.
 * 전환할 때마다 시점이 튀면 미로에서 방향 감각을 잃는다.
 */
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { CELL, EYE_H } from '../shared/constants'
import { resolveCircle, type Maze } from '../shared/maze'
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
/**
 * 카메라는 거리를 줄이지 않는다. 대신 두 가지를 한다.
 *
 *  1) 벽 밖으로 밀어낸다 — 시선 방향으로 당기는 게 아니라 옆으로 밀어낸다.
 *  2) 그래도 가리는 벽은 반투명하게 만든다 (MazeScene.updateWallOcclusion).
 *
 * 거리를 줄이는 방식은 좁은 통로에서 값이 쉴 새 없이 변해 어색했다.
 * 그렇다고 아무 처리도 안 하면 카메라가 벽 "안"에 들어가고, 그 벽이 투명해지면서
 * 벽 너머 통로까지 들여다보이게 된다. 옆으로 밀어내면 거리는 거의 유지되면서
 * 카메라가 항상 걸어다닐 수 있는 공간에 머문다.
 */
/** 카메라를 벽에서 밀어낼 때 쓰는 반지름. 플레이어보다 크게 잡아야 벽에 코를 박지 않는다. */
const CAMERA_RADIUS = 1.1

const MIN_PITCH = -0.9
const MAX_PITCH = 1.1

export class CameraController {
  mode: ViewMode = 'third'
  yaw = 0
  pitch = 0.25
  /** 마지막으로 적용한 카메라-캐릭터 평면 거리. 계측과 캐릭터 표시 판단에 쓴다. */
  private planarDistance = THIRD_DISTANCE
  /** 벽 밖으로 밀어낸 결과를 담는 재사용 객체. 매 프레임 새로 만들지 않는다. */
  private readonly resolved = { x: 0, z: 0 }
  /** 계측용. scripts/camera-probe.mjs 가 회전 시 거리 변화를 재는 데 쓴다. */
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

  update(view: MazeScene, maze: Maze, playerX: number, playerZ: number, _dt: number): void {
    const camera = view.camera

    if (this.mode === 'first') {
      camera.position.set(playerX, EYE_H, playerZ)
      camera.rotation.set(this.pitch, this.yaw, 0)
      this.planarDistance = 0
      // 1인칭은 시점이 캐릭터 안이라 가릴 벽이 없다.
      view.clearWallOcclusion()
      return
    }

    const sinYaw = Math.sin(this.yaw)
    const cosYaw = Math.cos(this.yaw)
    const cosPitch = Math.cos(this.pitch)

    // 뒤쪽 + 오른쪽 어깨 방향으로 합성한 고정 오프셋.
    const offsetX = -sinYaw * THIRD_DISTANCE * cosPitch + cosYaw * THIRD_SHOULDER
    const offsetZ = -cosYaw * THIRD_DISTANCE * cosPitch - sinYaw * THIRD_SHOULDER
    const offsetY = Math.sin(this.pitch) * THIRD_DISTANCE

    // 미로 바깥으로는 나가지 않게 막는다. 밖으로 나가면 아무것도 없는 공간이 보인다.
    const margin = 0.4
    const idealX = clamp(playerX + offsetX, margin, maze.w * CELL - margin)
    const idealZ = clamp(playerZ + offsetZ, margin, maze.h * CELL - margin)

    // 벽 안에 들어가 있으면 옆으로 밀어낸다. 거리를 줄이는 게 아니라 밀어내는 거라
    // 캐릭터와의 거리는 거의 그대로 유지된다.
    resolveCircle(maze, idealX, idealZ, CAMERA_RADIUS, this.resolved)
    const camX = this.resolved.x
    const camZ = this.resolved.z
    this.planarDistance = Math.hypot(camX - playerX, camZ - playerZ)
    this.debugScale = 1
    this.debugOvershoot = 0

    camera.position.set(camX, THIRD_PIVOT_H + offsetY, camZ)
    camera.setTarget(
      new Vector3(
        playerX + sinYaw * THIRD_LOOK_AHEAD,
        EYE_H - Math.sin(this.pitch) * THIRD_LOOK_AHEAD,
        playerZ + cosYaw * THIRD_LOOK_AHEAD,
      ),
    )

    view.updateWallOcclusion(camX, camZ, playerX, playerZ)
  }

  /** 카메라가 캐릭터에서 얼마나 떨어져 있는지(평면 거리). */
  distanceToPlayer(): number {
    return this.mode === 'first' ? 0 : this.planarDistance
  }
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value
}
