/**
 * 전송 계층 추상화.
 *
 * 게임 로직은 밑에 뭐가 깔려 있는지 몰라야 한다. 그래야 개발 중에는
 * InProcess / WebSocket 으로 빠르게 돌리고, 배포 때만 Steam P2P 로 갈아끼울 수 있다.
 *
 * reliable 플래그는 스팀의 SendType 을 그대로 반영한 것이다.
 * - 입력 / 스냅샷: unreliable. 최신 것만 의미가 있고 재전송은 오히려 해롭다.
 * - 참가 / 레벨 전환: reliable. 한 번 놓치면 상태가 영영 어긋난다.
 */

export type PeerId = string

export interface ClientTransport {
  /** 호스트로 보낸다. */
  send(data: Uint8Array, reliable?: boolean): void
  onMessage(cb: (data: Uint8Array) => void): void
  onClose(cb: () => void): void
  close(): void
}

export interface HostTransport {
  broadcast(data: Uint8Array, reliable?: boolean): void
  sendTo(peer: PeerId, data: Uint8Array, reliable?: boolean): void
  onPeerJoin(cb: (peer: PeerId) => void): void
  onPeerLeave(cb: (peer: PeerId) => void): void
  onMessage(cb: (peer: PeerId, data: Uint8Array) => void): void
  close(): void
}

/** 네트워크 상태 시뮬레이션 파라미터. */
export interface NetConditions {
  /** 편도 지연(ms). */
  latencyMs: number
  /** 지연 흔들림(ms). ±jitter 범위에서 균등 분포. */
  jitterMs: number
  /** unreliable 패킷 손실률 0~1. */
  loss: number
}

export const PERFECT_NET: NetConditions = { latencyMs: 0, jitterMs: 0, loss: 0 }
