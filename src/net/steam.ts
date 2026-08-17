/**
 * Steam P2P 전송 — 자리만 잡아둔 스텁.
 *
 * 여기는 브라우저에서 절대 동작하지 않는다. steamworks.js 는 네이티브 모듈이라
 * Electron 의 메인 프로세스(또는 preload)에서만 로드할 수 있고, 스팀 클라이언트가
 * 실행 중이어야 한다. 따라서 실제 구현은 Electron 을 붙일 때 채운다.
 *
 * 실제 API 대응은 이렇게 된다 (steamworks.js 기준):
 *
 *   const steam = require('steamworks.js').init(APP_ID)   // 개발 중에는 480 (Spacewar)
 *
 *   // 방 만들기 / 참가 — 로비 주인이 곧 호스트다
 *   const lobby = await steam.matchmaking.createLobby(LobbyType.FriendsOnly, MAX_PLAYERS)
 *   const lobby = await steam.matchmaking.joinLobby(lobbyId)
 *   lobby.getMembers()               // → PlayerSteamId[]
 *
 *   // 전송
 *   steam.networking.sendP2PPacket(steamId64, SendType.Unreliable, buffer)   // 입력 / 스냅샷
 *   steam.networking.sendP2PPacket(steamId64, SendType.Reliable,   buffer)   // 참가 / 레벨 전환
 *
 *   // 수신 — 폴링 방식이라 틱 루프 안에서 비워줘야 한다
 *   while (steam.networking.isP2PPacketAvailable() > 0) {
 *     const packet = steam.networking.readP2PPacket(size)
 *     ...
 *   }
 *   steam.networking.acceptP2PSession(steamId64)   // 첫 패킷 오기 전에 세션 수락 필요
 *
 * 주의할 점:
 * - Unreliable 은 1200 바이트 상한. protocol.ts 의 SNAPSHOT_MAX_BYTES 가 이 값이다.
 * - 릴레이(SDR)를 타므로 NAT 통과는 신경 쓸 필요가 없다.
 * - 호스트가 나가면 게임이 끝난다. 호스트 마이그레이션은 지금 범위 밖이다.
 */
import type { ClientTransport, HostTransport } from './transport'

const NOT_IMPLEMENTED =
  'SteamTransport 는 아직 구현되지 않았습니다. ' +
  'Electron 셸을 붙인 뒤 steamworks.js 로 채워야 하며, 브라우저에서는 동작하지 않습니다. ' +
  '개발 중에는 InProcessHub 또는 WebSocket 전송을 사용하세요.'

export function createSteamHostTransport(): HostTransport {
  throw new Error(NOT_IMPLEMENTED)
}

export function createSteamClientTransport(): ClientTransport {
  throw new Error(NOT_IMPLEMENTED)
}
