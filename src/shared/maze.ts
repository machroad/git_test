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

/** 미로 안에 뚫어놓은 사각형 방. 셀 단위 좌표. */
export interface Room {
  x: number
  y: number
  w: number
  h: number
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
  /** 뚫어놓은 사각형 방들. 미니맵에서 따로 표시한다. */
  rooms: Room[]
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
export interface MazeOptions {
  /** 뚫을 사각형 방 개수. 생략하면 크기에 맞춰 자동으로 정한다. */
  roomCount?: number
  /** 배치할 열쇠 개수. */
  keyCount?: number
  /** 막다른 길을 허물어 순환로를 만드는 비율. */
  braid?: number
}

export function generateMaze(w: number, h: number, seed: number, options: MazeOptions = {}): Maze {
  const braid = options.braid ?? 0.08
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
    rooms: [],
  }

  carveRooms(maze, rng, options.roomCount ?? roomCountForSize(Math.min(w, h)))
  placeLandmarks(maze, rng, Math.max(1, options.keyCount ?? 1))
  return maze
}

/**
 * 로비(일반 방). 미로가 아니라 벽 없는 사각형 공간 하나다.
 *
 * Maze 구조를 그대로 재사용하는 게 핵심이다. 충돌, 렌더링, 미니맵, 카메라의
 * 벽 회피가 전부 Maze 를 기준으로 돌기 때문에, 로비를 별도 타입으로 만들면
 * 그 코드를 전부 두 벌로 관리해야 한다.
 */
export function createLobbyMaze(size = 9): Maze {
  const cells = new Uint8Array(size * size).fill(ALL_WALLS)
  const maze: Maze = {
    w: size,
    h: size,
    seed: 0,
    cells,
    spawn: { x: (size / 2) | 0, y: (size / 2) | 0 },
    exit: { x: (size / 2) | 0, y: 1 },
    keys: [],
    rooms: [{ x: 0, y: 0, w: size, h: size }],
  }

  // 내부 벽만 전부 없앤다. 바깥 경계는 그대로 둬야 밖으로 못 나간다.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (x + 1 < size) {
        cells[cellIndex(maze, x, y)] &= ~E
        cells[cellIndex(maze, x + 1, y)] &= ~W
      }
      if (y + 1 < size) {
        cells[cellIndex(maze, x, y)] &= ~S
        cells[cellIndex(maze, x, y + 1)] &= ~N
      }
    }
  }

  return maze
}

/** 미로 크기에 따른 방 개수. 15x15 에서 2개, 커질수록 늘어난다. */
export function roomCountForSize(size: number): number {
  return Math.min(5, Math.max(2, Math.round(size / 7)))
}

/**
 * 통로만 있는 미로에 사각형 방을 뚫는다.
 *
 * 균일한 통로만 있으면 어디가 어딘지 구분이 안 되고, 협동 플레이에서
 * "저 방에서 만나자" 같은 약속을 할 수가 없다. 넓은 공간이 이정표 역할을 한다.
 *
 * 벽을 없애기만 하므로 미로의 연결성은 그대로 유지된다 (새 벽을 세우지 않는다).
 */
function carveRooms(maze: Maze, rng: Rng, target: number): void {
  if (target <= 0) return
  const maxRoom = Math.max(3, Math.min(5, Math.floor(maze.w / 4)))

  let attempts = 0
  while (maze.rooms.length < target && attempts < 200) {
    attempts++
    const rw = 3 + randInt(rng, maxRoom - 2)
    const rh = 3 + randInt(rng, maxRoom - 2)
    // 바깥 경계에 붙지 않게 한 칸 띄운다. 경계 벽을 건드리지 않기 위해서다.
    if (maze.w - rw - 2 <= 0 || maze.h - rh - 2 <= 0) break
    const rx = 1 + randInt(rng, maze.w - rw - 2)
    const ry = 1 + randInt(rng, maze.h - rh - 2)
    const room: Room = { x: rx, y: ry, w: rw, h: rh }

    // 방끼리 붙어서 하나의 큰 공간이 되지 않도록 한 칸 이상 띄운다.
    if (maze.rooms.some((other) => roomsOverlap(room, other, 1))) continue

    for (let y = ry; y < ry + rh; y++) {
      for (let x = rx; x < rx + rw; x++) {
        // 방 내부끼리 맞닿은 벽만 없앤다. 방 바깥 테두리는 그대로 둔다.
        if (x + 1 < rx + rw) {
          maze.cells[cellIndex(maze, x, y)] &= ~E
          maze.cells[cellIndex(maze, x + 1, y)] &= ~W
        }
        if (y + 1 < ry + rh) {
          maze.cells[cellIndex(maze, x, y)] &= ~S
          maze.cells[cellIndex(maze, x, y + 1)] &= ~N
        }
      }
    }
    maze.rooms.push(room)
  }
}

function roomsOverlap(a: Room, b: Room, margin: number): boolean {
  return (
    a.x - margin < b.x + b.w &&
    a.x + a.w + margin > b.x &&
    a.y - margin < b.y + b.h &&
    a.y + a.h + margin > b.y
  )
}

/** 해당 셀이 방 안에 있으면 그 방을 돌려준다. */
export function roomAt(maze: Maze, x: number, y: number): Room | null {
  for (const room of maze.rooms) {
    if (x >= room.x && x < room.x + room.w && y >= room.y && y < room.y + room.h) return room
  }
  return null
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
 * 그냥 "점수 높은 순"으로 뽑으면 열쇠들이 한 곳에 뭉치고, 탈출구 바로 옆에
 * 놓이기도 한다. 그러면 미로를 돌아다닐 이유가 사라진다. 그래서 최소 거리 조건을 건다.
 *
 *  - 스폰에서 충분히 멀 것 (시작하자마자 줍는 걸 막는다)
 *  - 탈출구에서 충분히 멀 것 (열쇠 먹고 바로 나가는 걸 막는다)
 *  - 열쇠끼리 충분히 멀 것 (한 번에 다 줍는 걸 막는다)
 *
 * 거리는 미로 지름에 비례한 값으로 잡는다. 절대값으로 잡으면 작은 미로에서
 * 조건을 만족하는 칸이 아예 없어진다. 그래도 못 채우면 조건을 조금씩 완화하며
 * 다시 시도하고, 끝내 안 되면 점수 순으로 채운다 — 열쇠가 부족한 채로 두면
 * 탈출구가 영영 안 열려서 게임이 진행 불가가 되기 때문이다.
 */
const KEY_MIN_FROM_SPAWN = 0.4
const KEY_MIN_FROM_EXIT = 0.3
const KEY_MIN_BETWEEN = 0.3

function placeLandmarks(maze: Maze, rng: Rng, keyCount: number) {
  const spawn = { x: 0, y: 0 }
  maze.spawn = spawn

  const fromSpawn = bfsDistances(maze, spawn)
  maze.exit = farthestCell(maze, fromSpawn)
  const fromExit = bfsDistances(maze, maze.exit)

  let maxDist = 0
  for (const d of fromSpawn) if (d > maxDist) maxDist = d

  // 동점일 때 항상 같은 칸이 뽑히면 지루하므로 시드 난수로 살짝 흔든다.
  // 정렬 전에 한 번만 만들어야 결정론이 유지된다.
  const jitter = new Float64Array(maze.w * maze.h)
  for (let i = 0; i < jitter.length; i++) jitter[i] = rng() * 0.5

  const candidates: number[] = []
  for (let i = 0; i < fromSpawn.length; i++) {
    if (fromSpawn[i] < 0 || fromExit[i] < 0) continue
    const x = i % maze.w
    const y = (i / maze.w) | 0
    if (x === spawn.x && y === spawn.y) continue
    if (x === maze.exit.x && y === maze.exit.y) continue
    candidates.push(i)
  }
  const score = (i: number) => fromSpawn[i] + fromExit[i] + jitter[i]
  candidates.sort((a, b) => score(b) - score(a))

  for (let attempt = 0; attempt < 10; attempt++) {
    const relax = Math.pow(0.75, attempt)
    const minSpawn = maxDist * KEY_MIN_FROM_SPAWN * relax
    const minExit = maxDist * KEY_MIN_FROM_EXIT * relax
    const minBetween = maxDist * KEY_MIN_BETWEEN * relax

    const chosen: number[] = []
    const chosenDists: Int32Array[] = []
    for (const i of candidates) {
      if (chosen.length >= keyCount) break
      if (fromSpawn[i] < minSpawn) continue
      if (fromExit[i] < minExit) continue
      if (chosenDists.some((d) => d[i] >= 0 && d[i] < minBetween)) continue
      chosen.push(i)
      chosenDists.push(bfsDistances(maze, { x: i % maze.w, y: (i / maze.w) | 0 }))
    }

    if (chosen.length === keyCount) {
      maze.keys = chosen.map((i) => ({ x: i % maze.w, y: (i / maze.w) | 0 }))
      return
    }
  }

  // 조건을 다 풀어도 못 채우면(아주 작은 미로) 점수 순으로 채운다.
  maze.keys = candidates
    .slice(0, keyCount)
    .map((i) => ({ x: i % maze.w, y: (i / maze.w) | 0 }))
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
