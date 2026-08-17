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
