'use client'

import * as React from 'react'
import { Popover as PopoverPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'

function Popover(props: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger(props: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  align = 'center',
  sideOffset = 4,
  style,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-[60] max-h-[--radix-popover-content-available-height] overflow-hidden rounded-md border border-border/50 bg-popover text-popover-foreground shadow-md outline-none data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          className
        )}
        // Why: Electron's -webkit-app-region: drag on the titlebar captures
        // clicks at the OS level regardless of z-index. Without no-drag,
        // popovers that visually overlap the titlebar are unclickable.
        style={{ ...style, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverContent, PopoverTrigger }
