/**
 * 우하단 미니맵.
 *
 * 탐사한 칸만 밝게 그린다. 탐사 정보는 "팀 전체"의 위치로 채워지므로,
 * 흩어져서 돌아다니면 지도가 빨리 열린다. 협동에 직접 보상을 주는 장치다.
 *
 * Babylon GUI 대신 2D 캔버스를 쓴다. 번들이 가볍고 이런 격자 그리기는 2D 가 훨씬 편하다.
 */
import { CELL } from '../shared/constants'
import { E, N, S, W, cellIndex, cellToWorld, type Maze } from '../shared/maze'
import type { RenderKey, RenderPlayer } from '../game/client-state'
import { showsKeysFor } from '../shared/items'
import { debugSettings } from './debug-settings'
import { PLAYER_COLORS } from './scene'

const PADDING = 6

/** 로비에서만 쓰는 표시 정보. 던전에서는 null 을 넘긴다. */
export interface LobbyMarkers {
  shop: { x: number; z: number }
  entrance: { x: number; z: number }
}

export class Minimap {
  /** 로컬 플레이어의 인벤토리. 나침반 여부에 따라 열쇠 표시가 달라진다. */
  inventory = 0

  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('미니맵 2D 컨텍스트를 만들 수 없습니다.')
    this.ctx = ctx
  }

  draw(
    maze: Maze,
    explored: Set<number>,
    players: RenderPlayer[],
    keys: RenderKey[],
    exitOpen: boolean,
    lobby: LobbyMarkers | null = null,
  ): void {
    const dpr = window.devicePixelRatio || 1
    const cssWidth = this.canvas.clientWidth
    const cssHeight = this.canvas.clientHeight
    if (cssWidth === 0 || cssHeight === 0) return

    if (this.canvas.width !== cssWidth * dpr || this.canvas.height !== cssHeight * dpr) {
      this.canvas.width = Math.round(cssWidth * dpr)
      this.canvas.height = Math.round(cssHeight * dpr)
    }

    const ctx = this.ctx
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssWidth, cssHeight)

    // 전체 보기를 켜면 탐사 여부와 상관없이 모든 칸을 그린다.
    // 탐사한 곳은 밝게, 아직 안 가본 곳은 어둡게 구분해서 진행도는 계속 보이게 한다.
    const revealAll = debugSettings.minimapRevealAll
    const isVisible = (index: number) => revealAll || explored.has(index)
    // 나침반을 샀으면 아직 안 가본 곳의 열쇠도 보인다.
    const showAllKeys = revealAll || showsKeysFor(this.inventory)

    const scale = Math.min(
      (cssWidth - PADDING * 2) / maze.w,
      (cssHeight - PADDING * 2) / maze.h,
    )
    const originX = (cssWidth - maze.w * scale) / 2
    const originY = (cssHeight - maze.h * scale) / 2

    // 월드 좌표 → 미니맵 좌표
    const toX = (worldX: number) => originX + (worldX / CELL) * scale
    const toY = (worldZ: number) => originY + (worldZ / CELL) * scale

    ctx.fillStyle = 'rgba(6, 8, 14, 0.82)'
    ctx.fillRect(0, 0, cssWidth, cssHeight)

    // 방 영역을 먼저 칠해서 바닥보다 아래에 깔리게 한다.
    if (debugSettings.highlightRooms) {
      ctx.fillStyle = 'rgba(110, 200, 255, 0.14)'
      for (const room of maze.rooms) {
        // 방 안에 보이는 칸이 하나라도 있을 때만 표시한다.
        let anyVisible = false
        for (let y = room.y; y < room.y + room.h && !anyVisible; y++) {
          for (let x = room.x; x < room.x + room.w; x++) {
            if (isVisible(y * maze.w + x)) { anyVisible = true; break }
          }
        }
        if (!anyVisible) continue
        ctx.fillRect(
          originX + room.x * scale,
          originY + room.y * scale,
          room.w * scale,
          room.h * scale,
        )
      }
    }

    // 칸 바닥. 탐사한 곳과 아닌 곳을 밝기로 구분한다.
    for (let cy = 0; cy < maze.h; cy++) {
      for (let cx = 0; cx < maze.w; cx++) {
        const index = cy * maze.w + cx
        if (!isVisible(index)) continue
        ctx.fillStyle = explored.has(index)
          ? 'rgba(120, 150, 200, 0.16)'
          : 'rgba(120, 150, 200, 0.05)'
        ctx.fillRect(originX + cx * scale, originY + cy * scale, scale, scale)
      }
    }

    // 벽. 탐사 여부에 따라 진하기를 달리해 두 번 그린다.
    for (const seen of [true, false]) {
      if (!seen && !revealAll) continue
      ctx.strokeStyle = seen ? 'rgba(170, 195, 235, 0.75)' : 'rgba(140, 165, 205, 0.22)'
      ctx.lineWidth = Math.max(1, scale * 0.12)
      ctx.beginPath()
      for (let cy = 0; cy < maze.h; cy++) {
        for (let cx = 0; cx < maze.w; cx++) {
          const index = cy * maze.w + cx
          if (!isVisible(index)) continue
          if (explored.has(index) !== seen) continue
          const mask = maze.cells[cellIndex(maze, cx, cy)]
          const x0 = originX + cx * scale
          const y0 = originY + cy * scale
          const x1 = x0 + scale
          const y1 = y0 + scale
          if (mask & N) { ctx.moveTo(x0, y0); ctx.lineTo(x1, y0) }
          if (mask & S) { ctx.moveTo(x0, y1); ctx.lineTo(x1, y1) }
          if (mask & W) { ctx.moveTo(x0, y0); ctx.lineTo(x0, y1) }
          if (mask & E) { ctx.moveTo(x1, y0); ctx.lineTo(x1, y1) }
        }
      }
      ctx.stroke()
    }

    // 방 테두리
    if (debugSettings.highlightRooms) {
      ctx.strokeStyle = 'rgba(120, 210, 255, 0.55)'
      ctx.lineWidth = Math.max(1, scale * 0.09)
      for (const room of maze.rooms) {
        if (!isVisible(room.y * maze.w + room.x) && !revealAll) continue
        ctx.strokeRect(
          originX + room.x * scale,
          originY + room.y * scale,
          room.w * scale,
          room.h * scale,
        )
      }
    }

    if (lobby) {
      // 로비에는 탈출구도 열쇠도 없다. 상점과 던전 입구를 대신 표시한다.
      const marker = scale * 0.66
      ctx.fillStyle = 'rgba(255, 200, 90, 0.95)'
      ctx.fillRect(toX(lobby.shop.x) - marker / 2, toY(lobby.shop.z) - marker / 2, marker, marker)

      ctx.fillStyle = 'rgba(190, 130, 255, 0.95)'
      ctx.beginPath()
      ctx.arc(toX(lobby.entrance.x), toY(lobby.entrance.z), marker / 2, 0, Math.PI * 2)
      ctx.fill()
    } else {
      // 탈출구는 목표라서 항상 보여준다. 열리기 전에는 흐리게.
      const exit = cellToWorld(maze.exit)
      ctx.fillStyle = exitOpen ? 'rgba(80, 255, 130, 0.95)' : 'rgba(255, 90, 95, 0.55)'
      const exitSize = scale * 0.62
      ctx.fillRect(toX(exit.x) - exitSize / 2, toY(exit.z) - exitSize / 2, exitSize, exitSize)
    }

    // 열쇠는 탐사한 곳에서만 보인다. 안 그러면 찾을 이유가 없어진다.
    // 나침반이 있으면 탐사와 무관하게 보인다.
    for (const key of keys) {
      if (key.collected) continue
      const cellX = Math.floor(key.x / CELL)
      const cellY = Math.floor(key.z / CELL)
      if (!showAllKeys && !isVisible(cellY * maze.w + cellX)) continue
      ctx.fillStyle = 'rgba(255, 218, 70, 0.95)'
      ctx.beginPath()
      ctx.arc(toX(key.x), toY(key.z), Math.max(2, scale * 0.26), 0, Math.PI * 2)
      ctx.fill()
    }

    // 플레이어
    for (const player of players) {
      if (player.escaped) continue
      const color = PLAYER_COLORS[(player.id - 1 + PLAYER_COLORS.length) % PLAYER_COLORS.length]
      const css = `rgb(${Math.round(color[0] * 255)}, ${Math.round(color[1] * 255)}, ${Math.round(color[2] * 255)})`
      const px = toX(player.x)
      const py = toY(player.z)

      if (player.isLocal) {
        // 내 캐릭터는 바라보는 방향까지 표시한다.
        ctx.save()
        ctx.translate(px, py)
        // 캔버스는 Y 축이 아래로 향하고, 월드 yaw 0 은 +Z(미니맵 아래)를 본다.
        // 위를 향한 삼각형을 그 방향으로 맞추려면 (PI - yaw) 만큼 돌린다.
        ctx.rotate(Math.PI - player.yaw)
        ctx.fillStyle = '#ffffff'
        ctx.beginPath()
        const r = Math.max(3.5, scale * 0.42)
        ctx.moveTo(0, -r)
        ctx.lineTo(r * 0.68, r * 0.72)
        ctx.lineTo(-r * 0.68, r * 0.72)
        ctx.closePath()
        ctx.fill()
        ctx.restore()
      } else {
        ctx.fillStyle = css
        ctx.beginPath()
        ctx.arc(px, py, Math.max(2.5, scale * 0.28), 0, Math.PI * 2)
        ctx.fill()
      }
    }

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)'
    ctx.lineWidth = 1
    ctx.strokeRect(0.5, 0.5, cssWidth - 1, cssHeight - 1)
  }
}
