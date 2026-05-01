import { Suspense, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { Canvas, type ThreeEvent, useFrame, useThree } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'

const LOG_PREFIX = '[pet-overlay]'

// Why: target half-height of the fitted model in world units. The camera is
// positioned so this extent exactly fills the viewport minus a padding
// factor, giving identical framing for every model regardless of its native
// scale or pivot. 1.0 is a round number — all downstream sizing derives from
// it deterministically.
const TARGET_HALF_EXTENT = 1

// Why: leave visible breathing room on top/bottom so the model never touches
// the viewport edges and the bob animation (see `BOB_AMPLITUDE`) stays fully
// in-frame. 0.72 = model fills ~72% of viewport height.
const FIT_FACTOR = 0.72

// Why: matches the previous idle-animation amplitude. Kept small so the fit
// padding above easily absorbs it without reintroducing clipping.
const BOB_AMPLITUDE = 0.04

function FittedPetModel({ animate, url }: { animate: boolean; url: string }): React.JSX.Element {
  const bobRef = useRef<THREE.Group>(null)
  const spinRef = useRef<THREE.Group>(null)
  const fitRef = useRef<THREE.Group>(null)
  const { camera, invalidate } = useThree()
  // Why: useGLTF suspends until the model is fetched and parsed; wrapped by
  // the parent <Suspense> so the fallback is "render nothing" rather than a
  // spinner. Use SkeletonUtils.clone (not Object3D.clone) because the bundled
  // GLBs contain SkinnedMesh rigs — a naive clone duplicates meshes + bones
  // but leaves mesh.skeleton.bones pointing at the *original* bone tree, so
  // the cloned mesh renders against one pose while Box3 measures against
  // another. That mismatch is what produced the "math says fits, pixels say
  // clipped" bug.
  const gltf = useGLTF(url)
  const scene = useMemo(() => cloneSkinned(gltf.scene) as THREE.Object3D, [gltf.scene])

  // Why: cloneSkinned allocates new geometries + skeletons; without disposing
  // them every model switch leaks GPU buffers. Materials are intentionally left
  // alone — SkeletonUtils.clone shares material refs with the original cache,
  // so disposing them would break re-mounts using the same GLB.
  useEffect(() => {
    return () => {
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh & { isMesh?: boolean; isSkinnedMesh?: boolean }
        if (mesh.isMesh || mesh.isSkinnedMesh) {
          mesh.geometry?.dispose()
          if (mesh.isSkinnedMesh) {
            const skinned = mesh as unknown as THREE.SkinnedMesh
            const skeleton = skinned.skeleton as
              | (THREE.Skeleton & { dispose?: () => void })
              | undefined
            skeleton?.dispose?.()
          }
        }
      })
    }
  }, [scene])

  useLayoutEffect(() => {
    const fitGroup = fitRef.current
    if (!fitGroup) {
      return
    }
    // Why: reset any prior fit transforms before measuring so switching
    // models doesn't accumulate scale/translation from the last fit.
    fitGroup.position.set(0, 0, 0)
    fitGroup.scale.set(1, 1, 1)
    fitGroup.updateMatrixWorld(true)

    // Why: manual Box3 fit rather than drei <Bounds>. <Bounds> fits a sphere
    // (wastes vertical space on tall thin models like the gremlin) and also
    // fought our parent-group `useFrame` position writes via its `observe`
    // mode, re-fitting every frame and drifting. Measuring the box once at
    // mount gives a deterministic, model-agnostic fit.
    // Why: force world matrices to be up-to-date before measuring so
    // Box3.setFromObject sees geometry in its actual local-space extent
    // rather than a partially-initialized graph. Without this call, models
    // whose GLB has parent transforms (rigged meshes with bone offsets) get
    // under-measured and the fit scales them too large, clipping the head.
    scene.updateMatrixWorld(true)
    // Why: force skinned meshes to refresh their bone matrices + per-mesh
    // bounding boxes, then measure with precise=true so the AABB is built
    // from posed vertex positions (getVertexPosition applies bone transforms
    // for SkinnedMesh) rather than bind-pose geometry.boundingBox. Without
    // this, rigs whose bind pose is shorter than the rest pose (demon horns
    // rotate upward when the skeleton binds) were reported as fitting while
    // the rendered silhouette clipped at the top.
    scene.traverse((obj) => {
      const mesh = obj as THREE.SkinnedMesh
      if ((mesh as THREE.Object3D & { isSkinnedMesh?: boolean }).isSkinnedMesh) {
        mesh.skeleton?.update()
        mesh.computeBoundingBox()
      }
    })
    const box = new THREE.Box3().setFromObject(scene, true)
    const size = new THREE.Vector3()
    const center = new THREE.Vector3()
    box.getSize(size)
    box.getCenter(center)

    // Why: the model spins around the y axis, so its on-screen silhouette
    // sweeps a cylinder of radius sqrt(x² + z²)/2 — not the AABB. Using the
    // AABB diagonal here means the widest frame during rotation (typically
    // around 45°) stays within the viewport instead of clipping the
    // shoulders/horns on tall-thin models like the demon.
    const horizontalDiameter = Math.hypot(size.x, size.z)
    const maxExtent = Math.max(horizontalDiameter, size.y)
    if (maxExtent === 0 || !Number.isFinite(maxExtent)) {
      return
    }

    // Why: scale so whichever is larger — the model's y extent or its
    // rotation-swept horizontal diameter — becomes 2×TARGET_HALF_EXTENT in
    // world units. Every bundled model ends up the same on-screen size and
    // never grows past the frame during the idle spin.
    const scale = (TARGET_HALF_EXTENT * 2) / maxExtent
    fitGroup.scale.setScalar(scale)
    // Why: translate so the model's geometric center sits at the spin
    // group's origin. Centering here instead of via <Center> avoids a second
    // scene-graph wrapper and keeps the rotation pivot on the model's
    // midpoint rather than its GLB origin (which may be at the feet).
    fitGroup.position.set(-center.x * scale, -center.y * scale, -center.z * scale)

    // Why: compute camera z from the vertical half-extent and the camera's
    // vertical FOV so the fitted model exactly fills FIT_FACTOR of the
    // viewport height. The canvas is square (220×220), so horizontal fit is
    // equivalent — but we always use the vertical calc because that's where
    // the observed clipping happened.
    const perspective = camera as THREE.PerspectiveCamera
    const fovRad = (perspective.fov * Math.PI) / 180
    const distance = TARGET_HALF_EXTENT / FIT_FACTOR / Math.tan(fovRad / 2)
    perspective.position.set(0, 0, distance)
    perspective.near = Math.max(0.1, distance - TARGET_HALF_EXTENT * 4)
    perspective.far = distance + TARGET_HALF_EXTENT * 4
    perspective.lookAt(0, 0, 0)
    perspective.updateProjectionMatrix()
    invalidate()
  }, [scene, camera, invalidate, url])

  const dragRef = useRef<{ active: boolean; pointerId: number; lastX: number; lastY: number }>({
    active: false,
    pointerId: -1,
    lastX: 0,
    lastY: 0
  })

  useFrame(() => {
    if (!animate) {
      return
    }
    const bob = bobRef.current
    if (bob) {
      // Why: subtle idle bob only — continuous y-spin was disorienting and
      // made the pet feel like a screensaver. Rotation is user-driven via
      // pointer drag (onPointerDown/Move/Up below).
      bob.position.y = Math.sin(performance.now() / 600) * BOB_AMPLITUDE
    }
  })

  const onPointerDown = (event: ThreeEvent<PointerEvent>): void => {
    // Why: r3f routes DOM pointer events through raycasting, so this only
    // fires when the ray hits the model mesh — not the empty canvas around
    // it. That means the surrounding transparent area still passes clicks
    // through to the app (pointer-events-auto on the canvas wrapper is
    // safe).
    event.stopPropagation()
    const native = event.nativeEvent
    const target = native.target as Element | null
    target?.setPointerCapture?.(native.pointerId)
    dragRef.current = {
      active: true,
      pointerId: native.pointerId,
      lastX: native.clientX,
      lastY: native.clientY
    }
  }
  const onPointerMove = (event: ThreeEvent<PointerEvent>): void => {
    const drag = dragRef.current
    if (!drag.active) {
      return
    }
    const native = event.nativeEvent
    const dx = native.clientX - drag.lastX
    const dy = native.clientY - drag.lastY
    drag.lastX = native.clientX
    drag.lastY = native.clientY
    const spin = spinRef.current
    if (spin) {
      // Why: horizontal drag → yaw, vertical drag → pitch. 0.03 rad/px —
      // ~two full turns per canvas-width of travel so a short flick produces
      // visible rotation on the 140px overlay.
      spin.rotation.y += dx * 0.03
      spin.rotation.x += dy * 0.03
    }
    invalidate()
  }
  const onPointerUp = (event: ThreeEvent<PointerEvent>): void => {
    // Why: multi-touch or a spurious pointerup from a different pointer
    // shouldn't terminate the active drag — only the pointer that started
    // the drag can end it.
    if (event.nativeEvent.pointerId !== dragRef.current.pointerId) {
      return
    }
    const native = event.nativeEvent
    const target = native.target as Element | null
    target?.releasePointerCapture?.(dragRef.current.pointerId)
    dragRef.current.active = false
  }

  return (
    <group
      ref={bobRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <group ref={spinRef}>
        <group ref={fitRef}>
          <primitive object={scene} />
        </group>
      </group>
    </group>
  )
}

export function PetScene({
  animate,
  modelUrl
}: {
  animate: boolean
  modelUrl: string
}): React.JSX.Element {
  useEffect(() => {
    // Why: only preload the currently-active model — drei dedupes by URL, and
    // other models load on demand when the user picks them. Eagerly warming
    // every bundled GLB burned bandwidth + decode time on mount for models the
    // user may never select.
    useGLTF.preload(modelUrl)
  }, [modelUrl])

  return (
    <Canvas
      // Why: transparent background so the pet sits directly on top of the
      // app chrome. `alpha: true` + clearColor 0 keeps every pixel outside
      // the mesh fully transparent.
      gl={{ alpha: true, antialias: true, preserveDrawingBuffer: false }}
      camera={{ position: [0, 0, 3.5], fov: 35 }}
      // Why: frameloop 'demand' when animation is disabled so the idle
      // state doesn't re-render every frame — saves battery when the user
      // prefers reduced motion or the window is backgrounded. The fit
      // effect calls invalidate() so the initial frame still renders.
      frameloop={animate ? 'always' : 'demand'}
      onCreated={({ gl }) => {
        gl.setClearColor(0x000000, 0)
      }}
      onError={(error) => {
        // Why: stable prefix per the design doc rollout step 4 so users can
        // surface the string when reporting WebGL-init failures across
        // platforms.
        console.warn(`${LOG_PREFIX} canvas error`, error)
      }}
    >
      <ambientLight intensity={0.6} />
      <directionalLight position={[2, 3, 2]} intensity={0.9} />
      <directionalLight position={[-2, 1, -1]} intensity={0.35} color={0x88aaff} />
      <Suspense fallback={null}>
        {/* Why: key forces a fresh mount (and therefore re-measurement) when
            the user switches models, since useLayoutEffect deps on `scene`
            identity — the key guarantees the prior fit's camera/scale
            cannot leak across model swaps. */}
        <FittedPetModel key={modelUrl} animate={animate} url={modelUrl} />
      </Suspense>
    </Canvas>
  )
}

export default PetScene
