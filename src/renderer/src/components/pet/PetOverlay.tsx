/* eslint-disable max-lines -- Why: keeping the lazy impl, WebGL capability
   probe, and visibility/reduced-motion handling in one module makes the
   boundary between "imports three.js" and "never imports three.js" explicit
   — the lazy() call below is the single three.js entrypoint. */
import { lazy, Suspense, useEffect, useState } from 'react'
import { usePetModelUrl } from './usePetModelUrl'

// Why: dynamic import is the whole point of gating three.js behind the
// experimental flag. Users who never enable `experimentalPet` pay zero bytes
// because React.lazy does not fetch the chunk until the component is
// actually rendered — and the PetOverlay is only mounted when the flag is
// on (see App.tsx). Changing this to a static import would defeat the
// design goal stated in pet-overlay.md (zero cost when disabled).
const PetScene = lazy(() => import('./PetScene'))

// Why: probed once per renderer. If WebGL is unavailable (some Linux/VM
// setups) we unmount silently rather than crash the app root. The design
// doc requires a single stable log prefix so dogfooders can grep their own
// console output — there is no in-app telemetry pipeline.
const LOG_PREFIX = '[pet-overlay]'

function detectWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas')
    const gl =
      canvas.getContext('webgl2') ??
      canvas.getContext('webgl') ??
      canvas.getContext('experimental-webgl')
    return gl !== null
  } catch {
    return false
  }
}

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() =>
    typeof document === 'undefined' ? true : document.visibilityState === 'visible'
  )
  useEffect(() => {
    const onChange = (): void => {
      setVisible(document.visibilityState === 'visible')
    }
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])
  return visible
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false
    }
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = (event: MediaQueryListEvent): void => setReduced(event.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

export function PetOverlay(): React.JSX.Element | null {
  const [webGLOk, setWebGLOk] = useState<boolean | null>(null)
  const documentVisible = useDocumentVisible()
  const reducedMotion = usePrefersReducedMotion()
  const { url: modelUrl, kind } = usePetModelUrl()

  useEffect(() => {
    // Why: WebGL probe is only meaningful for GLB pets. For image pets we
    // can skip three.js entirely, so we don't want a WebGL-less environment
    // to disable images too.
    if (kind !== 'glb') {
      return
    }
    const ok = detectWebGL()
    if (!ok) {
      // Why: design doc requires logging WebGL init failures under a stable
      // prefix so users who hit the fallback can surface the string when
      // reporting, and dogfooders can grep their own logs.
      console.warn(`${LOG_PREFIX} WebGL unavailable — pet overlay disabled for this session`)
    }
    setWebGLOk(ok)
  }, [kind])

  if (kind === 'glb' && (webGLOk === null || webGLOk === false)) {
    return null
  }

  return (
    // Why: wrapper is pointer-events-none so the app chrome underneath the
    // pet's bounding box remains interactive. For GLB pets the Canvas child
    // re-enables pointer events so r3f can raycast drags. For image pets we
    // leave everything pointer-events-none since there's no interaction (no
    // drag-to-rotate on 2D) — the child-selector that re-enables events is
    // scoped to `kind === 'glb'` so 2D pets don't silently eat clicks on the
    // terminal/chrome underneath. z-index sits just under typical modal layers.
    <div
      aria-hidden
      className={
        kind === 'glb'
          ? 'pointer-events-none fixed bottom-4 right-0 z-40 h-[140px] w-[140px] [&>div]:pointer-events-auto'
          : 'pointer-events-none fixed bottom-4 right-0 z-40 h-[140px] w-[140px]'
      }
    >
      {kind === 'image' ? (
        <ImagePet src={modelUrl} animate={documentVisible && !reducedMotion} />
      ) : (
        <Suspense fallback={null}>
          <PetScene animate={documentVisible && !reducedMotion} modelUrl={modelUrl} />
        </Suspense>
      )}
    </div>
  )
}

// Why: tiny inline component for 2D pets — static and animated formats
// (apng/gif/webp/svg) all render natively via <img>, no extra runtime. Bob
// uses CSS keyframes instead of the useFrame loop; reduced-motion or a
// backgrounded tab simply pauses the animation via `animation-play-state`.
function ImagePet({ src, animate }: { src: string; animate: boolean }): React.JSX.Element {
  return (
    <div
      className="flex size-full items-center justify-center"
      style={{
        animation: 'pet-bob 1.2s ease-in-out infinite',
        animationPlayState: animate ? 'running' : 'paused'
      }}
    >
      <style>
        {
          '@keyframes pet-bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }'
        }
      </style>
      <img src={src} alt="" className="max-h-full max-w-full object-contain" draggable={false} />
    </div>
  )
}

export default PetOverlay
