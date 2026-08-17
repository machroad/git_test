/**
 * 3인칭 카메라 부드러움 계측.
 *
 * yaw 를 균등하게 돌리면서 (a) 카메라 거리가 프레임 사이에 얼마나 튀는지,
 * (b) 스무딩 때문에 벽 안쪽으로 얼마나 넘어가는지를 잰다.
 * 프레임레이트에 의존하지 않으므로 GPU 없는 컨테이너에서도 의미가 있다.
 *
 *   npx tsx scripts/camera-probe.mjs
 *
 * 이 수치로 THIRD_DISTANCE 와 PULL_IN_TAU 를 정했다.
 * 처음에는 거리가 6개 이산값으로만 변해서 한 프레임에 1.43 단위씩 튀었고,
 * 그게 "화면이 뚝뚝 끊긴다"의 정체였다.
 */

import { generateMaze, cellToWorld } from '../src/shared/maze.ts'
import { CameraController } from '../src/client/camera.ts'

const maze = generateMaze(15, 15, 777)
const spawn = cellToWorld(maze.spawn)
// 통로 한가운데에서 관찰
const px = spawn.x + 4, pz = spawn.z + 4

const camera = new CameraController()
camera.setMode('third')

// Babylon 없이 위치만 받아쓰기 위한 최소 스텁
const fake = {
  camera: {
    position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z } },
    rotation: { set() {} },
    setTarget() {},
  },
}

const dists = []
const overshoot = []
const STEPS = 240  // 60fps 기준 4초에 한 바퀴
for (let i = 0; i < STEPS; i++) {
  camera.yaw = (i / STEPS) * Math.PI * 2
  // 스무딩 전 목표값(= 벽에 막히지 않는 최대 거리)과 실제 적용값의 차이를 잰다.
  const beforeScale = camera.debugScale
  camera.update(fake, maze, px, pz, 1 / 60)
  const p = fake.camera.position
  dists.push(Math.hypot(p.x - px, p.z - pz))
  void beforeScale
  overshoot.push(camera.debugOvershoot)
}

let maxJump = 0, jumps = 0
for (let i = 1; i < dists.length; i++) {
  const d = Math.abs(dists[i] - dists[i - 1])
  if (d > maxJump) maxJump = d
  if (d > 0.15) jumps++
}
const unique = new Set(dists.map((d) => d.toFixed(3)))

console.log(`yaw 를 1.5도씩 균등하게 돌렸을 때 (총 ${STEPS} 샘플)`)
console.log(`  거리 최소/최대 : ${Math.min(...dists).toFixed(2)} ~ ${Math.max(...dists).toFixed(2)}`)
console.log(`  서로 다른 거리 값 : ${unique.size} 종`)
console.log(`  0.15 이상 튀는 구간 : ${jumps}회`)
console.log(`  최대 점프 폭 : ${maxJump.toFixed(2)} 단위`)
const maxOver = Math.max(...overshoot)
const overFrames = overshoot.filter((o) => o > 0.02).length
console.log(`  벽 안쪽으로 넘어간 최대 깊이 : ${maxOver.toFixed(2)} 단위 (벽 두께 0.4)`)
console.log(`  넘어가 있던 프레임 : ${overFrames}/${STEPS}`)
