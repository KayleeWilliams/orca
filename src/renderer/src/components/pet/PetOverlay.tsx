import { useEffect, useState } from 'react'
import { usePetModelUrl } from './usePetModelUrl'

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

export function PetOverlay(): React.JSX.Element {
  const documentVisible = useDocumentVisible()
  const reducedMotion = usePrefersReducedMotion()
  const { url } = usePetModelUrl()
  const animate = documentVisible && !reducedMotion

  return (
    // Why: pointer-events-none so the app chrome underneath the pet stays
    // interactive — the pet is purely decorative. z-index sits just under
    // typical modal layers.
    <div
      aria-hidden
      className="pointer-events-none fixed bottom-4 right-3 z-40 h-[140px] w-[140px]"
    >
      <div
        className="flex size-full items-center justify-end"
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
        <img src={url} alt="" className="max-h-full max-w-full object-contain" draggable={false} />
      </div>
    </div>
  )
}

export default PetOverlay
