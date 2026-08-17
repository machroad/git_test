/**
 * Babylon.js 렌더링.
 *
 * 게임 상태를 받아 그리기만 한다. 여기에는 게임 규칙이 없다.
 * 벽은 thin instance 로 한 번에 그려서, 미로가 41x41 로 커져도 드로우콜이 늘지 않는다.
 */
import { Engine } from '@babylonjs/core/Engines/engine'
import { Scene } from '@babylonjs/core/scene'
import { Vector3, Matrix } from '@babylonjs/core/Maths/math.vector'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { PointLight } from '@babylonjs/core/Lights/pointLight'
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera'
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder'
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder'
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder'
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder'
import { CreateTorus } from '@babylonjs/core/Meshes/Builders/torusBuilder'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData'
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode'
// thinInstance* API 를 쓰려면 사이드이펙트 임포트가 필요하다.
import '@babylonjs/core/Meshes/thinInstanceMesh'

import { CELL, EYE_H, OCCLUSION_PAD, WALL_H, WALL_T } from '../shared/constants'
import {
  ATTACK_HALF_ANGLE,
  ATTACK_RANGE,
  ENEMY_DEFS,
  EnemyKind,
  type EnemyKindValue,
} from '../shared/combat'
import { cellToWorld, collectAllWalls, segmentHitsBox, type Aabb, type Maze } from '../shared/maze'
import type { RenderEnemy, RenderKey, RenderPlayer, RenderProjectile } from '../game/client-state'

/** 플레이어 색. id 순서대로 배정된다. */
export const PLAYER_COLORS: [number, number, number][] = [
  [0.35, 0.75, 1.0],
  [1.0, 0.62, 0.3],
  [0.55, 1.0, 0.55],
  [1.0, 0.5, 0.75],
]

export function playerColor(id: number): Color3 {
  const c = PLAYER_COLORS[(id - 1 + PLAYER_COLORS.length) % PLAYER_COLORS.length]
  return new Color3(c[0], c[1], c[2])
}

interface PlayerVisual {
  root: TransformNode
  body: Mesh
  nose: Mesh
}

interface EnemyVisual {
  root: Mesh
  body: Mesh
  material: StandardMaterial
  kind: number
  baseEmissive: Color3
}

/** 적 종류별 겉모습. 실루엣이 달라야 멀리서도 무엇인지 안다. */
const ENEMY_LOOKS: Record<EnemyKindValue, { color: Color3; shape: 'sphere' | 'box' | 'cone' }> = {
  [EnemyKind.Biter]: { color: new Color3(0.95, 0.35, 0.3), shape: 'sphere' },
  [EnemyKind.Brute]: { color: new Color3(0.85, 0.55, 0.2), shape: 'box' },
  [EnemyKind.Caster]: { color: new Color3(0.6, 0.35, 1), shape: 'cone' },
  [EnemyKind.Boss]: { color: new Color3(1, 0.2, 0.45), shape: 'box' },
}

export class MazeScene {
  readonly engine: Engine
  readonly scene: Scene
  readonly camera: UniversalCamera

  private wallMesh: Mesh | null = null
  /** 가려서 투명하게 그릴 벽만 담는 별도 메시. */
  private wallGhostMesh: Mesh | null = null
  private wallGhostMaterial: StandardMaterial | null = null
  /** 벽 AABB 목록과 원래 행렬. 인덱스가 thin instance 순서와 일치한다. */
  private wallBoxes: Aabb[] = []
  private wallMatrices: Matrix[] = []
  /** 지금 투명하게 처리 중인 벽 인덱스. 바뀔 때만 버퍼를 갱신한다. */
  private occluding = new Set<number>()
  private ground: Mesh | null = null
  private exitMesh: Mesh | null = null
  private exitMaterial: StandardMaterial
  private keyMeshes: Mesh[] = []
  private shopMesh: Mesh | null = null
  private entranceMesh: Mesh | null = null
  private keyMaterial: StandardMaterial
  private players = new Map<number, PlayerVisual>()
  private enemies = new Map<number, EnemyVisual>()
  private projectiles = new Map<number, Mesh>()
  private enemyMaterials = new Map<string, StandardMaterial>()
  private projectileMaterial: StandardMaterial | null = null
  private attackCone: Mesh | null = null
  private attackConeMaterial: StandardMaterial | null = null
  private attackConeAlpha = 0
  private torch: PointLight
  private wallMaterial: StandardMaterial
  private groundMaterial: StandardMaterial
  private elapsed = 0

  constructor(canvas: HTMLCanvasElement) {
    this.engine = new Engine(canvas, true, {
      preserveDrawingBuffer: false,
      stencil: false,
      // 여러 뷰를 동시에 띄울 때 컨텍스트 손실 복구가 필요하다.
      doNotHandleContextLost: false,
    })
    this.scene = new Scene(this.engine)
    this.scene.clearColor = new Color4(0.03, 0.04, 0.07, 1)

    // 미로다운 답답함과 시야 제한을 위해 안개를 깐다. 성능에도 도움이 된다.
    this.scene.fogMode = Scene.FOGMODE_EXP2
    this.scene.fogColor = new Color3(0.03, 0.04, 0.07)
    this.scene.fogDensity = 0.026

    this.camera = new UniversalCamera('camera', new Vector3(0, EYE_H, 0), this.scene)
    this.camera.minZ = 0.1
    this.camera.maxZ = 200
    this.camera.fov = 1.15
    // 카메라 조작은 직접 계산해서 넣는다.
    this.camera.inputs.clear()

    const ambient = new HemisphericLight('ambient', new Vector3(0, 1, 0), this.scene)
    ambient.intensity = 0.45
    ambient.diffuse = new Color3(0.6, 0.68, 0.9)
    ambient.groundColor = new Color3(0.1, 0.1, 0.16)

    this.torch = new PointLight('torch', new Vector3(0, EYE_H, 0), this.scene)
    this.torch.intensity = 1.2
    this.torch.range = 22
    this.torch.diffuse = new Color3(1, 0.94, 0.8)

    // 단색 벽은 1인칭에서 화면이 통째로 한 가지 색이 되어 방향 감각이 사라진다.
    // 가로 줄무늬를 넣으면 벽 길이와 상관없이 늘어나도 자연스럽고, 거리감이 생긴다.
    this.wallMaterial = new StandardMaterial('wall', this.scene)
    this.wallMaterial.diffuseTexture = createStripeTexture(this.scene)
    this.wallMaterial.diffuseColor = new Color3(0.62, 0.66, 0.82)
    this.wallMaterial.specularColor = new Color3(0.05, 0.05, 0.06)
    // 카메라가 순간적으로 벽 안으로 들어갈 때가 있다. 뒷면을 그려두면
    // 반대편이 비쳐 보이는 대신 어두워지기만 해서 훨씬 덜 어색하다.
    this.wallMaterial.backFaceCulling = false

    // 바닥 격자는 칸 경계를 보여줘서 이동 거리를 가늠하게 해준다.
    this.groundMaterial = new StandardMaterial('ground', this.scene)
    this.groundMaterial.diffuseTexture = createGridTexture(this.scene)
    this.groundMaterial.diffuseColor = new Color3(0.3, 0.33, 0.42)
    this.groundMaterial.specularColor = new Color3(0, 0, 0)

    this.exitMaterial = new StandardMaterial('exit', this.scene)
    this.exitMaterial.specularColor = new Color3(0, 0, 0)

    this.keyMaterial = new StandardMaterial('key', this.scene)
    this.keyMaterial.diffuseColor = new Color3(1, 0.85, 0.25)
    this.keyMaterial.emissiveColor = new Color3(0.8, 0.62, 0.1)
    this.keyMaterial.specularColor = new Color3(0, 0, 0)
  }

  /** 레벨이 바뀔 때마다 호출. 기존 미로 메시를 버리고 새로 만든다. */
  buildMaze(maze: Maze): void {
    this.wallMesh?.dispose()
    this.ground?.dispose()
    this.exitMesh?.dispose()
    for (const mesh of this.keyMeshes) mesh.dispose()
    this.keyMeshes = []

    const width = maze.w * CELL
    const depth = maze.h * CELL

    this.ground = CreateGround('ground', { width, height: depth }, this.scene)
    this.ground.position.set(width / 2, 0, depth / 2)
    this.ground.material = this.groundMaterial
    // 격자 한 칸이 미로 한 칸과 맞아떨어지게 타일링한다.
    const groundTexture = this.groundMaterial.diffuseTexture as DynamicTexture | null
    if (groundTexture) {
      groundTexture.uScale = maze.w
      groundTexture.vScale = maze.h
    }
    this.ground.freezeWorldMatrix()
    this.ground.isPickable = false

    const walls = collectAllWalls(maze)
    const base = CreateBox('wall', { size: 1 }, this.scene)
    base.material = this.wallMaterial
    base.isPickable = false

    const matrices = new Float32Array(walls.length * 16)
    this.wallBoxes = walls
    this.wallMatrices = []
    for (let i = 0; i < walls.length; i++) {
      const w = walls[i]
      const sx = Math.max(w.maxX - w.minX, WALL_T)
      const sz = Math.max(w.maxZ - w.minZ, WALL_T)
      const cx = (w.minX + w.maxX) / 2
      const cz = (w.minZ + w.maxZ) / 2
      const matrix = Matrix.Scaling(sx, WALL_H, sz).multiply(
        Matrix.Translation(cx, WALL_H / 2, cz),
      )
      matrix.copyToArray(matrices, i * 16)
      this.wallMatrices.push(matrix)
    }
    // 매 프레임 일부 인스턴스를 갈아끼우므로 정적 버퍼로 두면 안 된다.
    base.thinInstanceSetBuffer('matrix', matrices, 16, false)
    base.freezeWorldMatrix()
    this.wallMesh = base
    this.occluding.clear()

    // 가림 처리용 반투명 사본. 실제로 가리는 벽만 여기로 옮겨 그린다.
    this.wallGhostMesh?.dispose()
    if (!this.wallGhostMaterial) {
      const ghost = new StandardMaterial('wallGhost', this.scene)
      ghost.diffuseColor = new Color3(0.5, 0.56, 0.72)
      ghost.emissiveColor = new Color3(0.12, 0.14, 0.2)
      ghost.specularColor = new Color3(0, 0, 0)
      // 너무 투명하면 벽 너머 통로까지 들여다보인다. 캐릭터가 비칠 만큼만 연다.
      ghost.alpha = 0.34
      ghost.backFaceCulling = false
      // 반투명 벽 때문에 뒤쪽 물체가 가려지면 안 된다.
      ghost.disableDepthWrite = true
      this.wallGhostMaterial = ghost
    }
    const ghostMesh = CreateBox('wallGhost', { size: 1 }, this.scene)
    ghostMesh.material = this.wallGhostMaterial
    ghostMesh.isPickable = false
    ghostMesh.thinInstanceSetBuffer('matrix', new Float32Array(0), 16, false)
    this.wallGhostMesh = ghostMesh

    // 탈출구
    const exitPos = cellToWorld(maze.exit)
    this.exitMesh = CreateCylinder('exit', { diameter: CELL * 0.7, height: 0.12, tessellation: 24 }, this.scene)
    this.exitMesh.position.set(exitPos.x, 0.06, exitPos.z)
    this.exitMesh.material = this.exitMaterial
    this.exitMesh.isPickable = false

    // 열쇠
    for (let i = 0; i < maze.keys.length; i++) {
      const mesh = CreateTorus(`key${i}`, { diameter: 0.7, thickness: 0.18, tessellation: 18 }, this.scene)
      mesh.material = this.keyMaterial
      mesh.isPickable = false
      this.keyMeshes.push(mesh)
    }
  }

  /**
   * 로비 시설(상점 / 던전 구멍)을 배치한다. 던전에서는 null 을 넘겨 감춘다.
   * 미로와 같은 좌표계라 별도 처리가 없다.
   */
  setLobbyMarkers(shop: { x: number; z: number } | null, entrance: { x: number; z: number } | null): void {
    if (shop) {
      if (!this.shopMesh) {
        this.shopMesh = CreateBox('shop', { width: 2.6, height: 1.1, depth: 1.2 }, this.scene)
        const material = new StandardMaterial('shopMat', this.scene)
        material.diffuseColor = new Color3(0.75, 0.55, 0.25)
        material.emissiveColor = new Color3(0.28, 0.18, 0.05)
        material.specularColor = new Color3(0, 0, 0)
        this.shopMesh.material = material
        this.shopMesh.isPickable = false
      }
      this.shopMesh.position.set(shop.x, 0.55, shop.z)
      this.shopMesh.setEnabled(true)
    } else {
      this.shopMesh?.setEnabled(false)
    }

    if (entrance) {
      if (!this.entranceMesh) {
        // 바닥에 뚫린 구멍처럼 보이도록 어두운 원반을 살짝 띄워 놓는다.
        this.entranceMesh = CreateCylinder(
          'entrance',
          { diameter: 2.8, height: 0.08, tessellation: 28 },
          this.scene,
        )
        const material = new StandardMaterial('entranceMat', this.scene)
        material.diffuseColor = new Color3(0.02, 0.02, 0.04)
        material.emissiveColor = new Color3(0.16, 0.05, 0.28)
        material.specularColor = new Color3(0, 0, 0)
        this.entranceMesh.material = material
        this.entranceMesh.isPickable = false
      }
      this.entranceMesh.position.set(entrance.x, 0.04, entrance.z)
      this.entranceMesh.setEnabled(true)
    } else {
      this.entranceMesh?.setEnabled(false)
    }
  }

  syncPlayers(renderPlayers: RenderPlayer[]): void {
    const seen = new Set<number>()

    for (const player of renderPlayers) {
      seen.add(player.id)
      let visual = this.players.get(player.id)
      if (!visual) {
        visual = this.createPlayerVisual(player.id)
        this.players.set(player.id, visual)
      }
      visual.root.position.set(player.x, 0, player.z)
      visual.root.rotation.y = player.yaw
      // 탈출한 플레이어는 미로에서 사라진다.
      visual.body.setEnabled(!player.escaped)
      visual.nose.setEnabled(!player.escaped)
      // 1인칭에서 자기 몸이 화면을 가리지 않도록 로컬 플레이어는 숨긴다.
      // 3인칭 전환 시 다시 켜는 것은 updateCamera 쪽에서 처리한다.
    }

    for (const [id, visual] of this.players) {
      if (seen.has(id)) continue
      visual.root.dispose()
      this.players.delete(id)
    }
  }

  /** 1인칭일 때 자기 몸이 카메라를 가리므로 감춘다. */
  setLocalBodyVisible(localId: number, visible: boolean): void {
    const visual = this.players.get(localId)
    if (!visual) return
    visual.body.setEnabled(visible)
    visual.nose.setEnabled(visible)
  }

  /** 적 메시를 스냅샷에 맞춰 갱신한다. 없어진 적은 지운다. */
  syncEnemies(enemies: RenderEnemy[]): void {
    const seen = new Set<number>()
    for (const enemy of enemies) {
      seen.add(enemy.id)
      let visual = this.enemies.get(enemy.id)
      if (!visual || visual.kind !== enemy.kind) {
        visual?.root.dispose()
        visual = this.createEnemyVisual(enemy.kind)
        this.enemies.set(enemy.id, visual)
      }
      visual.root.position.set(enemy.x, 0, enemy.z)
      visual.root.rotation.y = enemy.yaw

      // 예비 동작 중에는 몸이 부풀어 오른다. "지금 때린다"를 미리 알려야 피할 수 있다.
      const scale = enemy.windup ? 1.22 : 1
      visual.body.scaling.set(scale, scale, scale)
      // 체력이 줄면 어두워진다. 체력바를 따로 띄우지 않아도 상태가 보인다.
      const shade = 0.35 + enemy.hp * 0.65
      visual.material.emissiveColor = visual.baseEmissive.scale(enemy.windup ? 2.2 : shade)
    }

    for (const [id, visual] of this.enemies) {
      if (seen.has(id)) continue
      visual.root.dispose()
      this.enemies.delete(id)
    }
  }

  syncProjectiles(projectiles: RenderProjectile[]): void {
    const seen = new Set<number>()
    for (const projectile of projectiles) {
      seen.add(projectile.id)
      let mesh = this.projectiles.get(projectile.id)
      if (!mesh) {
        if (!this.projectileMaterial) {
          const material = new StandardMaterial('projectileMat', this.scene)
          material.diffuseColor = new Color3(0.75, 0.45, 1)
          material.emissiveColor = new Color3(0.6, 0.3, 1)
          material.specularColor = new Color3(0, 0, 0)
          this.projectileMaterial = material
        }
        mesh = CreateSphere(`projectile${projectile.id}`, { diameter: 0.7, segments: 8 }, this.scene)
        mesh.material = this.projectileMaterial
        mesh.isPickable = false
        this.projectiles.set(projectile.id, mesh)
      }
      mesh.position.set(projectile.x, 1.2, projectile.z)
    }

    for (const [id, mesh] of this.projectiles) {
      if (seen.has(id)) continue
      mesh.dispose()
      this.projectiles.delete(id)
    }
  }

  syncKeys(keys: RenderKey[], exitOpen: boolean, dt: number): void {
    this.elapsed += dt

    for (let i = 0; i < this.keyMeshes.length; i++) {
      const mesh = this.keyMeshes[i]
      const key = keys[i]
      if (!key) {
        mesh.setEnabled(false)
        continue
      }
      mesh.setEnabled(true)
      // 들려 있으면 머리 위로 올라간다. 누가 열쇠를 가졌는지 멀리서도 보인다.
      const height = key.collected ? 2.1 : 0.9 + Math.sin(this.elapsed * 2) * 0.12
      mesh.position.set(key.x, height, key.z)
      mesh.rotation.y = this.elapsed * 1.6
      mesh.rotation.x = Math.PI / 2
    }

    if (this.exitMesh) {
      const color = exitOpen ? new Color3(0.3, 1, 0.45) : new Color3(1, 0.28, 0.3)
      this.exitMaterial.diffuseColor = color
      const pulse = exitOpen ? 0.5 + Math.sin(this.elapsed * 4) * 0.25 : 0.22
      this.exitMaterial.emissiveColor = color.scale(pulse)
    }
  }

  /**
   * 공격 범위 표시. 캐릭터 앞 부채꼴을 바닥에 깔아준다.
   *
   * 평소에는 아주 흐리게 깔아둬서 "내 공격이 어디까지 닿는지" 를 익힐 수 있게 하고,
   * 실제로 휘두르는 순간에만 밝게 번쩍인다. 판정과 똑같은 각도·거리로 그리므로
   * 보이는 것과 맞는 것이 어긋나지 않는다.
   */
  setAttackRange(
    x: number,
    z: number,
    yaw: number,
    swinging: boolean,
    visible: boolean,
    dt: number,
  ): void {
    if (!this.attackCone) {
      const material = new StandardMaterial('attackCone', this.scene)
      material.emissiveColor = new Color3(0.55, 0.85, 1)
      material.diffuseColor = new Color3(0, 0, 0)
      material.specularColor = new Color3(0, 0, 0)
      material.disableLighting = true
      material.backFaceCulling = false
      this.attackConeMaterial = material

      this.attackCone = buildSectorMesh(this.scene, ATTACK_RANGE, ATTACK_HALF_ANGLE)
      this.attackCone.material = material
      this.attackCone.isPickable = false
      // 바닥과 z-fighting 하지 않도록 살짝 띄운다.
      this.attackCone.position.y = 0.08
    }

    const cone = this.attackCone
    const material = this.attackConeMaterial!

    if (!visible) {
      cone.setEnabled(false)
      this.attackConeAlpha = 0
      return
    }
    cone.setEnabled(true)
    cone.position.set(x, 0.08, z)
    cone.rotation.y = yaw

    // 휘두르면 확 밝아졌다가 서서히 원래의 흐린 상태로 돌아간다.
    const target = swinging ? 0.5 : 0.08
    const speed = swinging ? 1 : Math.min(1, dt * 5)
    this.attackConeAlpha += (target - this.attackConeAlpha) * speed
    material.alpha = this.attackConeAlpha
  }

  /**
   * 카메라와 캐릭터 사이를 가로막는 벽을 반투명하게 바꾼다.
   *
   * 이게 없으면 카메라가 벽을 피해 계속 앞뒤로 움직여야 하고, 그 움직임 자체가
   * 어색하다. 벽을 비워주면 카메라를 고정할 수 있다.
   *
   * 가리는 벽은 보통 0~3개다. 집합이 바뀔 때만 버퍼를 갱신해서, 가만히 있을 때는
   * 아무 일도 하지 않는다.
   */
  updateWallOcclusion(camX: number, camZ: number, playerX: number, playerZ: number): void {
    const wall = this.wallMesh
    const ghost = this.wallGhostMesh
    if (!wall || !ghost) return

    const hit = new Set<number>()
    // 선분의 경계 상자로 먼저 걸러낸다. 대부분의 벽은 여기서 탈락한다.
    const minX = Math.min(camX, playerX) - OCCLUSION_PAD
    const maxX = Math.max(camX, playerX) + OCCLUSION_PAD
    const minZ = Math.min(camZ, playerZ) - OCCLUSION_PAD
    const maxZ = Math.max(camZ, playerZ) + OCCLUSION_PAD

    for (let i = 0; i < this.wallBoxes.length; i++) {
      const box = this.wallBoxes[i]
      if (box.maxX < minX || box.minX > maxX || box.maxZ < minZ || box.minZ > maxZ) continue
      if (segmentHitsBox(camX, camZ, playerX, playerZ, box, OCCLUSION_PAD)) hit.add(i)
    }

    if (sameSet(hit, this.occluding)) return

    // 이전에 숨겼다가 이제 안 가리는 벽은 되돌린다.
    for (const index of this.occluding) {
      if (!hit.has(index)) wall.thinInstanceSetMatrixAt(index, this.wallMatrices[index], false)
    }
    // 새로 가리는 벽은 크기를 0으로 만들어 사실상 지운다.
    for (const index of hit) {
      if (!this.occluding.has(index)) wall.thinInstanceSetMatrixAt(index, ZERO_MATRIX, false)
    }
    wall.thinInstanceBufferUpdated('matrix')

    // 지운 자리에 반투명 사본을 놓는다.
    const ghostData = new Float32Array(hit.size * 16)
    let slot = 0
    for (const index of hit) {
      this.wallMatrices[index].copyToArray(ghostData, slot * 16)
      slot++
    }
    ghost.thinInstanceSetBuffer('matrix', ghostData, 16, false)

    this.occluding = hit
  }

  /**
   * 가림 처리를 전부 되돌린다.
   *
   * 1인칭에서는 카메라와 캐릭터가 같은 자리라 가릴 것이 없다. 그런데도 길이 0인
   * 선분으로 판정하면, 벽에 붙어 선 순간 그 벽이 여유 반경에 걸려 사라져 버린다.
   */
  clearWallOcclusion(): void {
    const wall = this.wallMesh
    const ghost = this.wallGhostMesh
    if (!wall || !ghost || this.occluding.size === 0) return

    for (const index of this.occluding) {
      wall.thinInstanceSetMatrixAt(index, this.wallMatrices[index], false)
    }
    wall.thinInstanceBufferUpdated('matrix')
    ghost.thinInstanceSetBuffer('matrix', new Float32Array(0), 16, false)
    this.occluding.clear()
  }

  /** 로컬 플레이어 위치에 손전등을 붙인다. 랜턴 아이템이 있으면 더 멀리 비춘다. */
  setTorch(x: number, z: number, range: number): void {
    this.torch.position.set(x, EYE_H + 0.3, z)
    this.torch.range = range
  }

  /**
   * engine.runRenderLoop 을 쓰지 않고 직접 렌더한다.
   * 뷰가 여러 개일 때 프레임 순서를 우리가 통제해야 하기 때문이다.
   * 그 경우 beginFrame / endFrame 을 직접 감싸줘야 한다.
   */
  render(): void {
    this.engine.beginFrame()
    this.scene.render()
    this.engine.endFrame()
  }

  resize(): void {
    this.engine.resize()
  }

  dispose(): void {
    this.scene.dispose()
    this.engine.dispose()
  }

  private createEnemyVisual(kind: number): EnemyVisual {
    const def = ENEMY_DEFS[kind as EnemyKindValue] ?? ENEMY_DEFS[EnemyKind.Biter]
    const look = ENEMY_LOOKS[kind as EnemyKindValue] ?? ENEMY_LOOKS[EnemyKind.Biter]

    let material = this.enemyMaterials.get(String(kind))
    if (!material) {
      material = new StandardMaterial(`enemyMat${kind}`, this.scene)
      material.diffuseColor = look.color
      material.specularColor = new Color3(0.05, 0.05, 0.05)
      this.enemyMaterials.set(String(kind), material)
    }

    const root = CreateBox(`enemyRoot${kind}`, { size: 0.001 }, this.scene)
    root.isVisible = false
    root.isPickable = false

    // 종류마다 실루엣을 다르게 해서 멀리서도 구분되게 한다.
    const body =
      look.shape === 'sphere'
        ? CreateSphere('enemyBody', { diameter: def.radius * 2.1, segments: 10 }, this.scene)
        : look.shape === 'box'
          ? CreateBox('enemyBody', { size: def.radius * 1.9 }, this.scene)
          : CreateCylinder(
              'enemyBody',
              { diameterTop: 0, diameterBottom: def.radius * 2.2, height: def.radius * 3, tessellation: 8 },
              this.scene,
            )
    body.material = material
    body.position.y = def.radius * 1.2
    body.isPickable = false
    body.parent = root

    return { root, body, material, kind, baseEmissive: look.color.scale(0.5) }
  }

  private createPlayerVisual(id: number): PlayerVisual {
    const color = playerColor(id)

    const body = CreateCylinder(`player${id}`, { diameter: 0.9, height: 1.5, tessellation: 12 }, this.scene)
    const material = new StandardMaterial(`playerMat${id}`, this.scene)
    material.diffuseColor = color
    material.emissiveColor = color.scale(0.25)
    material.specularColor = new Color3(0.1, 0.1, 0.1)
    body.material = material
    body.position.y = 0.75
    body.isPickable = false

    // 어느 쪽을 보는지 알려주는 표식. 3인칭에서 방향 감각에 꽤 중요하다.
    const nose = CreateSphere(`nose${id}`, { diameter: 0.32, segments: 8 }, this.scene)
    nose.material = material
    nose.position.set(0, 1.15, 0.42)
    nose.isPickable = false

    const root = CreateBox(`root${id}`, { size: 0.001 }, this.scene)
    root.isVisible = false
    root.isPickable = false
    body.parent = root
    nose.parent = root

    return { root, body, nose }
  }
}

const ZERO_MATRIX = Matrix.Scaling(0, 0, 0)

/** 두 집합이 같은지. 가리는 벽이 그대로면 버퍼를 건드리지 않는다. */
function sameSet(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false
  for (const value of a) if (!b.has(value)) return false
  return true
}

/**
 * 부채꼴 메시를 직접 만든다.
 *
 * CreateDisc 를 회전시켜 쓸 수도 있지만, 그러면 시작 각도와 회전 축을 맞추느라
 * 방향이 헷갈린다. XZ 평면에 직접 부채꼴을 만들면 yaw 규약(0 = +Z)과 바로 맞아떨어진다.
 */
function buildSectorMesh(scene: Scene, radius: number, halfAngle: number): Mesh {
  const segments = 24
  const positions: number[] = [0, 0, 0]
  const indices: number[] = []

  for (let i = 0; i <= segments; i++) {
    const angle = -halfAngle + (halfAngle * 2 * i) / segments
    // yaw 0 이 +Z 를 보므로 방향 벡터는 (sin, cos) 이다.
    positions.push(Math.sin(angle) * radius, 0, Math.cos(angle) * radius)
    if (i > 0) indices.push(0, i, i + 1)
  }

  const mesh = new Mesh('attackCone', scene)
  const data = new VertexData()
  data.positions = positions
  data.indices = indices
  data.normals = positions.map((_, i) => (i % 3 === 1 ? 1 : 0))
  data.applyToMesh(mesh)
  return mesh
}

/** 벽면용 가로 줄무늬. 벽 길이에 따라 늘어나도 가로 방향이라 티가 나지 않는다. */
function createStripeTexture(scene: Scene): DynamicTexture {
  const size = 128
  const texture = new DynamicTexture('wallTex', { width: size, height: size }, scene, false)
  const ctx = texture.getContext() as unknown as CanvasRenderingContext2D

  ctx.fillStyle = '#6b7186'
  ctx.fillRect(0, 0, size, size)

  // 벽돌층처럼 보이도록 밝기가 조금씩 다른 가로 띠를 쌓는다.
  const bands = 8
  for (let i = 0; i < bands; i++) {
    const shade = 0.82 + ((i * 37) % 11) / 40
    const v = Math.round(107 * shade)
    ctx.fillStyle = `rgb(${v}, ${Math.round(v * 1.05)}, ${Math.round(v * 1.24)})`
    ctx.fillRect(0, (i * size) / bands, size, size / bands - 2)
  }

  texture.update()
  texture.uScale = 1
  texture.vScale = 1
  return texture
}

/** 바닥용 격자. 한 타일이 미로 한 칸에 대응한다. */
function createGridTexture(scene: Scene): DynamicTexture {
  const size = 128
  const texture = new DynamicTexture('groundTex', { width: size, height: size }, scene, false)
  const ctx = texture.getContext() as unknown as CanvasRenderingContext2D

  ctx.fillStyle = '#3a4054'
  ctx.fillRect(0, 0, size, size)
  ctx.strokeStyle = '#525a75'
  ctx.lineWidth = 4
  ctx.strokeRect(2, 2, size - 4, size - 4)

  texture.update()
  return texture
}
