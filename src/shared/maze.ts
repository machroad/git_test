/**
 * 미로 생성 및 질의.
 *
 * 좌표계: 셀 (x, y) 에서 x 는 월드 +X, y 는 월드 +Z 방향으로 증가한다.
 * 방향 비트: N = -Z, E = +X, S = +Z, W = -X.
 * 비트가 서 있으면 그 방향에 벽이 있다는 뜻이다.
 */
import { CELL, PLAYER_R, WALL_T } from './constants'
import { mulberry32, randInt, shuffle, type Rng } from './rng'

export const N = 1
export const E = 2
export const S = 4
export const W = 8
export const ALL_WALLS = N | E | S | W

export interface Cell {
  x: number
  y: number
}

export interface Maze {
  w: number
  h: number
  seed: number
  /** 셀별 벽 비트마스크. 길이 w*h. */
  cells: Uint8Array
  /** 플레이어 스폰 셀. */
  spawn: Cell
  /** 탈출구 셀. */
  exit: Cell
  /** 열쇠가 놓인 셀들. */
  keys: Cell[]
}

const DIRS: { bit: number; dx: number; dy: number; opposite: number }[] = [
  { bit: N, dx: 0, dy: -1, opposite: S },
  { bit: E, dx: 1, dy: 0, opposite: W },
  { bit: S, dx: 0, dy: 1, opposite: N },
  { bit: W, dx: -1, dy: 0, opposite: E },
]

export function cellIndex(maze: Pick<Maze, 'w'>, x: number, y: number): number {
  return y * maze.w + x
}

export function inBounds(maze: Pick<Maze, 'w' | 'h'>, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < maze.w && y < maze.h
}

export function hasWall(maze: Maze, x: number, y: number, dirBit: number): boolean {
  if (!inBounds(maze, x, y)) return true
  return (maze.cells[cellIndex(maze, x, y)] & dirBit) !== 0
}

/** 셀 중심의 월드 좌표 (XZ 평면). */
export function cellToWorld(cell: Cell): { x: number; z: number } {
  return { x: (cell.x + 0.5) * CELL, z: (cell.y + 0.5) * CELL }
}

/** 월드 좌표가 속한 셀. 범위 밖이면 클램프한다. */
export function worldToCell(maze: Pick<Maze, 'w' | 'h'>, x: number, z: number): Cell {
  const cx = Math.min(maze.w - 1, Math.max(0, Math.floor(x / CELL)))
  const cy = Math.min(maze.h - 1, Math.max(0, Math.floor(z / CELL)))
  return { x: cx, y: cy }
}

/**
 * 시드로부터 미로를 생성한다. 같은 (w, h, seed) 는 항상 같은 미로를 만든다.
 *
 * 기본 알고리즘은 recursive backtracker(완전미로)이고, 그 뒤에 벽 일부를 추가로
 * 허물어 순환로를 만든다. 완전미로는 막다른 길이 너무 많아 협동 플레이에서
 * 서로 엇갈리기만 하고 재미가 떨어진다.
 */
export function generateMaze(w: number, h: number, seed: number, braid = 0.08): Maze {
  const rng = mulberry32(seed)
  const cells = new Uint8Array(w * h).fill(ALL_WALLS)
  const visited = new Uint8Array(w * h)

  const start = { x: randInt(rng, w), y: randInt(rng, h) }
  const stack: Cell[] = [start]
  visited[start.y * w + start.x] = 1

  while (stack.length > 0) {
    const cur = stack[stack.length - 1]
    const candidates = shuffle(
      rng,
      DIRS.filter((d) => {
        const nx = cur.x + d.dx
        const ny = cur.y + d.dy
        return nx >= 0 && ny >= 0 && nx < w && ny < h && !visited[ny * w + nx]
      }),
    )

    if (candidates.length === 0) {
      stack.pop()
      continue
    }

    const dir = candidates[0]
    const nx = cur.x + dir.dx
    const ny = cur.y + dir.dy
    cells[cur.y * w + cur.x] &= ~dir.bit
    cells[ny * w + nx] &= ~dir.opposite
    visited[ny * w + nx] = 1
    stack.push({ x: nx, y: ny })
  }

  braidMaze(rng, { w, h, cells }, braid)

  const maze: Maze = {
    w,
    h,
    seed,
    cells,
    spawn: { x: 0, y: 0 },
    exit: { x: w - 1, y: h - 1 },
    keys: [],
  }

  placeLandmarks(maze, rng)
  return maze
}

/** 막다른 길 일부의 벽을 허물어 순환로를 만든다. */
function braidMaze(rng: Rng, maze: { w: number; h: number; cells: Uint8Array }, ratio: number) {
  if (ratio <= 0) return
  const { w, h, cells } = maze
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const mask = cells[y * w + x]
      // 벽이 3개면 막다른 길
      const wallCount = (mask & N ? 1 : 0) + (mask & E ? 1 : 0) + (mask & S ? 1 : 0) + (mask & W ? 1 : 0)
      if (wallCount < 3) continue
      if (rng() > ratio) continue

      const openable = shuffle(
        rng,
        DIRS.filter((d) => {
          if ((mask & d.bit) === 0) return false
          const nx = x + d.dx
          const ny = y + d.dy
          return nx >= 0 && ny >= 0 && nx < w && ny < h
        }),
      )
      if (openable.length === 0) continue
      const dir = openable[0]
      cells[y * w + x] &= ~dir.bit
      cells[(y + dir.dy) * w + (x + dir.dx)] &= ~dir.opposite
    }
  }
}

/**
 * 스폰 / 탈출구 / 열쇠 위치를 정한다.
 *
 * 탈출구는 스폰에서 가장 먼 곳, 열쇠는 (스폰 거리 + 탈출구 거리) 가 최대인 곳에 둔다.
 * 그래야 "열쇠 찾으러 갔다가 탈출구로 돌아온다"는 동선이 만들어진다.
 */
function placeLandmarks(maze: Maze, rng: Rng) {
  const spawn = { x: 0, y: 0 }
  maze.spawn = spawn

  const fromSpawn = bfsDistances(maze, spawn)
  maze.exit = farthestCell(maze, fromSpawn)

  const fromExit = bfsDistances(maze, maze.exit)
  let best: Cell = { x: 0, y: 0 }
  let bestScore = -1
  for (let y = 0; y < maze.h; y++) {
    for (let x = 0; x < maze.w; x++) {
      const i = y * maze.w + x
      if (fromSpawn[i] < 0 || fromExit[i] < 0) continue
      if (x === spawn.x && y === spawn.y) continue
      if (x === maze.exit.x && y === maze.exit.y) continue
      // 동점일 때 항상 같은 셀이 뽑히면 지루하므로 시드 난수로 살짝 흔든다.
      const score = fromSpawn[i] + fromExit[i] + rng() * 0.5
      if (score > bestScore) {
        bestScore = score
        best = { x, y }
      }
    }
  }
  maze.keys = [best]
}

/** 미로 그래프상의 BFS 거리. 도달 불가 셀은 -1. */
export function bfsDistances(maze: Maze, from: Cell): Int32Array {
  const dist = new Int32Array(maze.w * maze.h).fill(-1)
  const queue: number[] = [from.y * maze.w + from.x]
  dist[queue[0]] = 0
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]
    const cx = cur % maze.w
    const cy = (cur / maze.w) | 0
    for (const d of DIRS) {
      if (hasWall(maze, cx, cy, d.bit)) continue
      const nx = cx + d.dx
      const ny = cy + d.dy
      if (!inBounds(maze, nx, ny)) continue
      const ni = ny * maze.w + nx
      if (dist[ni] >= 0) continue
      dist[ni] = dist[cur] + 1
      queue.push(ni)
    }
  }
  return dist
}

function farthestCell(maze: Maze, dist: Int32Array): Cell {
  let bestIdx = 0
  let bestDist = -1
  for (let i = 0; i < dist.length; i++) {
    if (dist[i] > bestDist) {
      bestDist = dist[i]
      bestIdx = i
    }
  }
  return { x: bestIdx % maze.w, y: (bestIdx / maze.w) | 0 }
}

// ---------------------------------------------------------------------------
// 충돌
// ---------------------------------------------------------------------------

export interface Aabb {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

/**
 * 셀 하나가 가진 벽들의 AABB 를 out 배열에 채운다.
 *
 * 모서리에서 플레이어가 새는 것을 막기 위해 벽 길이를 양쪽으로 두께의 절반만큼
 * 늘린다. 렌더링용 벽 메시도 같은 규칙을 쓰므로 보이는 것과 막히는 것이 일치한다.
 */
export function collectCellWalls(maze: Maze, cx: number, cy: number, out: Aabb[]): void {
  if (!inBounds(maze, cx, cy)) return
  const mask = maze.cells[cellIndex(maze, cx, cy)]
  const x0 = cx * CELL
  const z0 = cy * CELL
  const x1 = x0 + CELL
  const z1 = z0 + CELL
  const t = WALL_T / 2

  if (mask & N) out.push({ minX: x0 - t, maxX: x1 + t, minZ: z0 - t, maxZ: z0 + t })
  if (mask & S) out.push({ minX: x0 - t, maxX: x1 + t, minZ: z1 - t, maxZ: z1 + t })
  if (mask & W) out.push({ minX: x0 - t, maxX: x0 + t, minZ: z0 - t, maxZ: z1 + t })
  if (mask & E) out.push({ minX: x1 - t, maxX: x1 + t, minZ: z0 - t, maxZ: z1 + t })
}

/** 렌더링용 전체 벽 목록. 인접 셀이 공유하는 벽은 한 번만 낸다. */
export function collectAllWalls(maze: Maze): Aabb[] {
  const out: Aabb[] = []
  const t = WALL_T / 2
  for (let y = 0; y < maze.h; y++) {
    for (let x = 0; x < maze.w; x++) {
      const mask = maze.cells[cellIndex(maze, x, y)]
      const x0 = x * CELL
      const z0 = y * CELL
      const x1 = x0 + CELL
      const z1 = z0 + CELL
      // N / W 벽은 항상 그리고, S / E 는 바깥 경계에서만 그린다.
      // 벽을 허물 때 양쪽 셀의 비트를 함께 지우므로 이 규칙으로 중복 없이 전부 나온다.
      if (mask & N) out.push({ minX: x0 - t, maxX: x1 + t, minZ: z0 - t, maxZ: z0 + t })
      if (mask & W) out.push({ minX: x0 - t, maxX: x0 + t, minZ: z0 - t, maxZ: z1 + t })
      if (y === maze.h - 1 && mask & S) out.push({ minX: x0 - t, maxX: x1 + t, minZ: z1 - t, maxZ: z1 + t })
      if (x === maze.w - 1 && mask & E) out.push({ minX: x1 - t, maxX: x1 + t, minZ: z0 - t, maxZ: z1 + t })
    }
  }
  return out
}

const scratchWalls: Aabb[] = []

/**
 * 원(플레이어)을 주변 벽 밖으로 밀어낸다. 결과를 out 에 쓴다.
 *
 * 물리 엔진을 쓰지 않는 이유는 앞서 정한 대로다. 이동이 순수 함수라서
 * 호스트와 클라이언트가 같은 코드로 같은 결과를 내고, 테스트도 쉽다.
 */
export function resolveCircle(
  maze: Maze,
  x: number,
  z: number,
  radius: number,
  out: { x: number; z: number },
): void {
  let px = x
  let pz = z

  // 모서리에서 두 벽에 동시에 끼는 경우가 있어 두 번 반복한다.
  for (let pass = 0; pass < 2; pass++) {
    scratchWalls.length = 0
    const center = worldToCell(maze, px, pz)
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        collectCellWalls(maze, center.x + dx, center.y + dy, scratchWalls)
      }
    }

    let moved = false
    for (const wall of scratchWalls) {
      const closestX = Math.min(wall.maxX, Math.max(wall.minX, px))
      const closestZ = Math.min(wall.maxZ, Math.max(wall.minZ, pz))
      let dx = px - closestX
      let dz = pz - closestZ
      let distSq = dx * dx + dz * dz

      if (distSq >= radius * radius) continue

      if (distSq > 1e-9) {
        const dist = Math.sqrt(distSq)
        const push = radius - dist
        px += (dx / dist) * push
        pz += (dz / dist) * push
      } else {
        // 벽 안에 완전히 파묻힌 경우: 침투가 가장 얕은 축으로 밀어낸다.
        const toLeft = px - wall.minX
        const toRight = wall.maxX - px
        const toTop = pz - wall.minZ
        const toBottom = wall.maxZ - pz
        const minPen = Math.min(toLeft, toRight, toTop, toBottom)
        if (minPen === toLeft) px = wall.minX - radius
        else if (minPen === toRight) px = wall.maxX + radius
        else if (minPen === toTop) pz = wall.minZ - radius
        else pz = wall.maxZ + radius
      }
      moved = true
    }
    if (!moved) break
  }

  out.x = px
  out.z = pz
}

/** 두 월드 좌표 사이가 벽으로 막혀 있는지 (카메라 클리핑 방지용 근사). */
export function segmentBlocked(maze: Maze, x0: number, z0: number, x1: number, z1: number): boolean {
  const dx = x1 - x0
  const dz = z1 - z0
  const steps = Math.max(2, Math.ceil(Math.hypot(dx, dz) / (WALL_T * 0.5)))
  const probe = { x: 0, z: 0 }
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const px = x0 + dx * t
    const pz = z0 + dz * t
    resolveCircle(maze, px, pz, PLAYER_R * 0.4, probe)
    if (Math.abs(probe.x - px) > 1e-4 || Math.abs(probe.z - pz) > 1e-4) return true
  }
  return false
}
