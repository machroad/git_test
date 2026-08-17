/**
 * 같은 프로세스 안에서 호스트와 클라이언트를 연결하는 전송 구현.
 *
 * 이게 이 프로젝트의 테스트 핵심이다. 네트워크 없이 한 브라우저 탭 안에서
 * 호스트 1명 + 클라이언트 N명을 동시에 돌릴 수 있고, 지연/지터/손실을 주입해
 * "150ms + 5% 손실" 같은 조건을 매번 똑같이 재현할 수 있다.
 * 실제 스팀 릴레이로는 이런 조건을 일부러 만들기가 어렵다.
 */
import type { ClientTransport, HostTransport, NetConditions, PeerId } from './transport'
import { PERFECT_NET } from './transport'

interface Link {
  peer: PeerId
  toHost: ((data: Uint8Array) => void) | null
  toClient: ((data: Uint8Array) => void) | null
  clientClosed: (() => void) | null
}

export class InProcessHub {
  net: NetConditions
  private links = new Map<PeerId, Link>()
  private hostMessage: ((peer: PeerId, data: Uint8Array) => void) | null = null
  private hostJoin: ((peer: PeerId) => void) | null = null
  private hostLeave: ((peer: PeerId) => void) | null = null
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private nextPeer = 1
  private closed = false
  /** 지연 계산에 쓰는 난수. 재현성이 필요하면 교체할 수 있게 열어 둔다. */
  random: () => number = Math.random

  constructor(net: NetConditions = PERFECT_NET) {
    this.net = { ...net }
  }

  createHostTransport(): HostTransport {
    const hub = this
    return {
      broadcast(data, reliable = false) {
        for (const peer of hub.links.keys()) hub.deliverToClient(peer, data, reliable)
      },
      sendTo(peer, data, reliable = false) {
        hub.deliverToClient(peer, data, reliable)
      },
      onPeerJoin(cb) {
        hub.hostJoin = cb
      },
      onPeerLeave(cb) {
        hub.hostLeave = cb
      },
      onMessage(cb) {
        hub.hostMessage = cb
      },
      close() {
        hub.close()
      },
    }
  }

  createClientTransport(): ClientTransport {
    const hub = this
    const peer: PeerId = `p${this.nextPeer++}`
    const link: Link = { peer, toHost: null, toClient: null, clientClosed: null }
    this.links.set(peer, link)

    // 호스트의 onPeerJoin 은 클라이언트가 콜백을 등록할 틈을 준 뒤에 부른다.
    this.schedule(() => hub.hostJoin?.(peer), 0)

    return {
      send(data, reliable = false) {
        hub.deliverToHost(peer, data, reliable)
      },
      onMessage(cb) {
        link.toClient = cb
      },
      onClose(cb) {
        link.clientClosed = cb
      },
      close() {
        if (!hub.links.has(peer)) return
        hub.links.delete(peer)
        link.clientClosed?.()
        hub.schedule(() => hub.hostLeave?.(peer), 0)
      },
    }
  }

  setConditions(net: Partial<NetConditions>): void {
    Object.assign(this.net, net)
  }

  close(): void {
    this.closed = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    for (const link of this.links.values()) link.clientClosed?.()
    this.links.clear()
  }

  private deliverToHost(peer: PeerId, data: Uint8Array, reliable: boolean) {
    if (this.shouldDrop(reliable)) return
    const copy = data.slice()
    this.schedule(() => {
      if (!this.links.has(peer)) return
      this.hostMessage?.(peer, copy)
    }, this.delay())
  }

  private deliverToClient(peer: PeerId, data: Uint8Array, reliable: boolean) {
    if (this.shouldDrop(reliable)) return
    const copy = data.slice()
    this.schedule(() => {
      const link = this.links.get(peer)
      link?.toClient?.(copy)
    }, this.delay())
  }

  private shouldDrop(reliable: boolean): boolean {
    if (reliable) return false
    return this.net.loss > 0 && this.random() < this.net.loss
  }

  private delay(): number {
    const jitter = this.net.jitterMs > 0 ? (this.random() * 2 - 1) * this.net.jitterMs : 0
    return Math.max(0, this.net.latencyMs + jitter)
  }

  private schedule(fn: () => void, ms: number) {
    if (this.closed) return
    // 지연 0이어도 setTimeout 을 거쳐야 호출 스택이 분리되어 실제 네트워크와
    // 같은 비동기 특성을 갖는다. 동기 호출로 두면 "호스트에서만 되는" 버그를 놓친다.
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      fn()
    }, ms)
    this.timers.add(timer)
  }
}
