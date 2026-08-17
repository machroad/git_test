import { describe, expect, it } from 'vitest'
import {
  E,
  N,
  S,
  W,
  bfsDistances,
  cellIndex,
  generateMaze,
  hasWall,
  roomCountForSize,
} from '../src/shared/maze'

describe('미로 생성', () => {
  it('같은 시드는 항상 같은 미로를 만든다', () => {
    // 이게 깨지면 시드만 보내는 방식이 성립하지 않는다. 네트코드의 전제 조건이다.
    const a = generateMaze(15, 15, 12345)
    const b = generateMaze(15, 15, 12345)
    expect(Array.from(a.cells)).toEqual(Array.from(b.cells))
    expect(a.exit).toEqual(b.exit)
    expect(a.keys).toEqual(b.keys)
  })

  it('다른 시드는 다른 미로를 만든다', () => {
    const a = generateMaze(15, 15, 1)
    const b = generateMaze(15, 15, 2)
    expect(Array.from(a.cells)).not.toEqual(Array.from(b.cells))
  })

  it('인접한 두 셀의 벽 정보가 서로 일치한다', () => {
    const maze = generateMaze(21, 21, 777)
    for (let y = 0; y < maze.h; y++) {
      for (let x = 0; x < maze.w; x++) {
        if (x + 1 < maze.w) {
          expect(hasWall(maze, x, y, E)).toBe(hasWall(maze, x + 1, y, W))
        }
        if (y + 1 < maze.h) {
          expect(hasWall(maze, x, y, S)).toBe(hasWall(maze, x, y + 1, N))
        }
      }
    }
  })

  it('바깥 경계는 항상 막혀 있다', () => {
    const maze = generateMaze(15, 15, 42)
    for (let x = 0; x < maze.w; x++) {
      expect(maze.cells[cellIndex(maze, x, 0)] & N).toBeTruthy()
      expect(maze.cells[cellIndex(maze, x, maze.h - 1)] & S).toBeTruthy()
    }
    for (let y = 0; y < maze.h; y++) {
      expect(maze.cells[cellIndex(maze, 0, y)] & W).toBeTruthy()
      expect(maze.cells[cellIndex(maze, maze.w - 1, y)] & E).toBeTruthy()
    }
  })

  it('모든 칸이 스폰 지점에서 도달 가능하다', () => {
    // 도달 불가능한 칸에 열쇠가 놓이면 게임이 진행 불가가 된다.
    for (const seed of [1, 2, 3, 99, 12345]) {
      const maze = generateMaze(19, 19, seed)
      const dist = bfsDistances(maze, maze.spawn)
      const unreachable = Array.from(dist).filter((d) => d < 0)
      expect(unreachable).toHaveLength(0)
    }
  })

  it('스폰 / 열쇠 / 탈출구가 서로 다른 칸에 놓인다', () => {
    for (const seed of [1, 7, 555, 9999]) {
      const maze = generateMaze(15, 15, seed)
      const positions = [maze.spawn, maze.exit, ...maze.keys].map((c) => `${c.x},${c.y}`)
      expect(new Set(positions).size).toBe(positions.length)
    }
  })

  it('열쇠가 스폰 바로 옆에 놓이지 않는다', () => {
    // 열쇠를 즉시 주우면 미로를 탐색할 이유가 사라진다.
    const maze = generateMaze(21, 21, 31337)
    const dist = bfsDistances(maze, maze.spawn)
    for (const key of maze.keys) {
      expect(dist[cellIndex(maze, key.x, key.y)]).toBeGreaterThan(5)
    }
  })
})

describe('사각형 방', () => {
  it('미로 크기에 따라 방이 만들어진다', () => {
    expect(roomCountForSize(15)).toBe(2)
    const maze = generateMaze(15, 15, 2024)
    expect(maze.rooms.length).toBe(2)
    for (const room of maze.rooms) {
      expect(room.w).toBeGreaterThanOrEqual(3)
      expect(room.h).toBeGreaterThanOrEqual(3)
    }
  })

  it('방 내부에는 벽이 없다', () => {
    const maze = generateMaze(21, 21, 31337)
    expect(maze.rooms.length).toBeGreaterThan(0)
    for (const room of maze.rooms) {
      for (let y = room.y; y < room.y + room.h; y++) {
        for (let x = room.x; x < room.x + room.w; x++) {
          if (x + 1 < room.x + room.w) expect(hasWall(maze, x, y, E)).toBe(false)
          if (y + 1 < room.y + room.h) expect(hasWall(maze, x, y, S)).toBe(false)
        }
      }
    }
  })

  it('방은 바깥 경계에 닿지 않는다', () => {
    // 경계 벽을 허물면 미로 밖으로 나가버린다.
    for (const seed of [1, 2, 3, 77, 4242]) {
      const maze = generateMaze(21, 21, seed)
      for (const room of maze.rooms) {
        expect(room.x).toBeGreaterThanOrEqual(1)
        expect(room.y).toBeGreaterThanOrEqual(1)
        expect(room.x + room.w).toBeLessThanOrEqual(maze.w - 1)
        expect(room.y + room.h).toBeLessThanOrEqual(maze.h - 1)
      }
    }
  })

  it('방끼리 겹치지 않는다', () => {
    for (const seed of [5, 55, 555, 5555]) {
      const maze = generateMaze(31, 31, seed)
      for (let i = 0; i < maze.rooms.length; i++) {
        for (let j = i + 1; j < maze.rooms.length; j++) {
          const a = maze.rooms[i]
          const b = maze.rooms[j]
          const overlaps =
            a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
          expect(overlaps).toBe(false)
        }
      }
    }
  })

  it('방을 뚫어도 모든 칸이 여전히 도달 가능하다', () => {
    // 방 생성은 벽을 없애기만 하므로 연결성이 깨지면 안 된다.
    for (const seed of [1, 9, 99, 999]) {
      const maze = generateMaze(21, 21, seed)
      const dist = bfsDistances(maze, maze.spawn)
      expect(Array.from(dist).filter((d) => d < 0)).toHaveLength(0)
    }
  })

  it('같은 시드는 같은 방 배치를 만든다', () => {
    expect(generateMaze(21, 21, 808).rooms).toEqual(generateMaze(21, 21, 808).rooms)
  })
})
