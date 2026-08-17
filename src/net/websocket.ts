/**
 * WebSocket 클라이언트 전송. 로컬에서 실제 두 대 이상으로 붙여볼 때 쓴다.
 *
 * WebSocket 은 TCP 위라서 전부 신뢰성 전송이다. reliable 플래그는 무시된다.
 * 즉 여기서는 "패킷 손실 시 동작"을 검증할 수 없으므로, 그 검증은
 * InProcessHub 의 손실 주입으로 하고 여기서는 실제 왕복 지연만 본다.
 */
import type { ClientTransport } from './transport'

export function connectWebSocket(url: string): Promise<ClientTransport> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.binaryType = 'arraybuffer'

    let onMessage: ((data: Uint8Array) => void) | null = null
    let onClose: (() => void) | null = null
    let settled = false

    socket.addEventListener('open', () => {
      settled = true
      resolve({
        send(data) {
          if (socket.readyState === WebSocket.OPEN) socket.send(data)
        },
        onMessage(cb) {
          onMessage = cb
        },
        onClose(cb) {
          onClose = cb
        },
        close() {
          socket.close()
        },
      })
    })

    socket.addEventListener('message', (event) => {
      if (event.data instanceof ArrayBuffer) onMessage?.(new Uint8Array(event.data))
    })

    socket.addEventListener('close', () => {
      if (!settled) reject(new Error(`WebSocket 연결 실패: ${url}`))
      onClose?.()
    })

    socket.addEventListener('error', () => {
      if (!settled) {
        settled = true
        reject(new Error(`WebSocket 연결 실패: ${url}`))
      }
    })
  })
}
