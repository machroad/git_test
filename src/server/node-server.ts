/**
 * WebSocket 호스트. 로컬에서 실제로 두 대 이상 붙여볼 때 쓴다.
 *
 * 여기서는 호스트가 플레이어를 겸하지 않는 순수 서버다. 스팀으로 옮길 때는
 * 호스트도 플레이어가 되지만, GameHost 는 그대로 두고 HostTransport 만
 * SteamTransport 로 바꾸면 된다. 게임 로직은 손댈 필요가 없다.
 *
 *   npm run server
 *   # 다른 기기 브라우저에서: http://<호스트IP>:5173/?ws=ws://<호스트IP>:8080
 */
import { WebSocketServer, type WebSocket } from 'ws'
import { GameHost } from '../game/host'
import type { HostTransport, PeerId } from '../net/transport'

const PORT = Number(process.env.PORT ?? 8080)

class WebSocketHostTransport implements HostTransport {
  private server: WebSocketServer
  private peers = new Map<PeerId, WebSocket>()
  private nextPeer = 1
  private joinCb: ((peer: PeerId) => void) | null = null
  private leaveCb: ((peer: PeerId) => void) | null = null
  private messageCb: ((peer: PeerId, data: Uint8Array) => void) | null = null

  constructor(port: number) {
    this.server = new WebSocketServer({ port })
    this.server.on('connection', (socket) => {
      const peer: PeerId = `ws${this.nextPeer++}`
      this.peers.set(peer, socket)
      socket.binaryType = 'nodebuffer'
      console.log(`[server] ${peer} 접속`)
      this.joinCb?.(peer)

      socket.on('message', (raw: Buffer) => {
        this.messageCb?.(peer, new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength))
      })
      socket.on('close', () => {
        this.peers.delete(peer)
        console.log(`[server] ${peer} 접속 종료`)
        this.leaveCb?.(peer)
      })
      socket.on('error', (error) => {
        console.warn(`[server] ${peer} 오류:`, error.message)
      })
    })
  }

  broadcast(data: Uint8Array): void {
    for (const socket of this.peers.values()) send(socket, data)
  }

  sendTo(peer: PeerId, data: Uint8Array): void {
    const socket = this.peers.get(peer)
    if (socket) send(socket, data)
  }

  onPeerJoin(cb: (peer: PeerId) => void): void {
    this.joinCb = cb
  }

  onPeerLeave(cb: (peer: PeerId) => void): void {
    this.leaveCb = cb
  }

  onMessage(cb: (peer: PeerId, data: Uint8Array) => void): void {
    this.messageCb = cb
  }

  close(): void {
    this.server.close()
  }
}

function send(socket: WebSocket, data: Uint8Array) {
  // OPEN 이 아닌 소켓에 쓰면 예외가 난다. 끊기는 순간에 흔하다.
  if (socket.readyState === socket.OPEN) socket.send(data)
}

const transport = new WebSocketHostTransport(PORT)
const host = new GameHost(transport, { seed: (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1 })
host.start()

console.log(`[server] 미로 탈출 호스트가 ws://0.0.0.0:${PORT} 에서 대기 중입니다.`)
console.log(`[server] 클라이언트: http://<이 PC의 IP>:5173/?ws=ws://<이 PC의 IP>:${PORT}`)

process.on('SIGINT', () => {
  console.log('\n[server] 종료합니다.')
  host.stop()
  transport.close()
  process.exit(0)
})
