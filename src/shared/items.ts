/**
 * 아이템 정의와 효과.
 *
 * 아이템은 "가지고 있냐 없냐"만 관리한다(비트마스크). 개수나 소모품이 없어서
 * 스냅샷에 1바이트로 들어가고, 호스트/클라이언트 양쪽에서 같은 함수로 효과를 계산한다.
 * 효과 계산이 shared 에 있는 게 중요하다 — 클라이언트 예측이 이동 속도를
 * 호스트와 똑같이 계산해야 하기 때문이다.
 */
import { PLAYER_SPEED } from './constants'

export const ItemId = {
  SwiftBoots: 0,
  Lantern: 1,
  Compass: 2,
  KeySense: 3,
} as const

export type ItemIdValue = (typeof ItemId)[keyof typeof ItemId]

export interface ItemDef {
  id: ItemIdValue
  name: string
  price: number
  description: string
}

/** 상점에 진열되는 순서대로. */
export const ITEMS: ItemDef[] = [
  {
    id: ItemId.SwiftBoots,
    name: '신속의 장화',
    price: 60,
    description: '이동 속도 +20%. 넓은 미로에서 체감이 크다.',
  },
  {
    id: ItemId.Lantern,
    name: '랜턴',
    price: 45,
    description: '주변이 더 밝아지고 미니맵이 한 칸 더 넓게 열린다.',
  },
  {
    id: ItemId.Compass,
    name: '나침반',
    price: 80,
    description: '아직 안 가본 곳이라도 열쇠 위치가 미니맵에 보인다.',
  },
  {
    id: ItemId.KeySense,
    name: '열쇠 감각',
    price: 35,
    description: '가장 가까운 열쇠까지의 거리를 알려준다.',
  },
]

export function itemById(id: number): ItemDef | undefined {
  return ITEMS.find((item) => item.id === id)
}

// ---------------------------------------------------------------------------
// 인벤토리는 비트마스크 하나로 표현한다.
// ---------------------------------------------------------------------------

export function hasItem(inventory: number, id: ItemIdValue): boolean {
  return (inventory & (1 << id)) !== 0
}

export function withItem(inventory: number, id: ItemIdValue): number {
  return inventory | (1 << id)
}

// ---------------------------------------------------------------------------
// 효과. 호스트 시뮬레이션과 클라이언트 예측이 반드시 같은 값을 써야 한다.
// ---------------------------------------------------------------------------

export function moveSpeedFor(inventory: number): number {
  return hasItem(inventory, ItemId.SwiftBoots) ? PLAYER_SPEED * 1.2 : PLAYER_SPEED
}

/** 미니맵에서 한 번에 열리는 반경(칸). */
export function revealRadiusFor(inventory: number): number {
  return hasItem(inventory, ItemId.Lantern) ? 1 : 0
}

export function torchRangeFor(inventory: number): number {
  return hasItem(inventory, ItemId.Lantern) ? 30 : 22
}

export function showsKeysFor(inventory: number): boolean {
  return hasItem(inventory, ItemId.Compass)
}

export function showsKeyDistanceFor(inventory: number): boolean {
  return hasItem(inventory, ItemId.KeySense)
}
