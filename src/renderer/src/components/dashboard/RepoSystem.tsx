/* eslint-disable max-lines -- Why: RepoSystem is a single SVG component whose
layout constants, animation styles, and rendering are tightly coupled. Splitting
the SVG template across files would scatter the coordinate system and make the
visual layout harder to trace during debugging. */
import React from 'react'
import { formatAgentTypeLabel } from '@/lib/agent-status'
import type { DashboardRepoGroup } from './useDashboardData'
import type { TooltipData } from './ConcentricView'

// ─── Layout Constants ────────────────────────────────────────────────────────
// Why: the SVG viewBox is fixed at 280x280 so each repo "system" renders as a
// square that scales to the sidebar width. Radii define the three concentric
// rings: outer (repo boundary), orbit (where worktrees sit), and inner (decorative).
const SVG_SIZE = 280
const CX = SVG_SIZE / 2
const CY = SVG_SIZE / 2
const REPO_RING_R = 115
const ORBIT_R = 75
const INNER_DECOR_R = 28
const BASE_WT_R = 24
const BASE_AGENT_R = 8

// ─── State Colors ────────────────────────────────────────────────────────────
// Why: hardcoded hex values ensure consistent SVG rendering regardless of CSS
// variable availability. These match the Tailwind color tokens used in the
// card-grid dashboard (emerald-500, amber-500, sky-500, zinc-500).
const STATE_COLORS: Record<string, { fill: string; glow: string }> = {
  working: { fill: '#10b981', glow: '#34d399' },
  blocked: { fill: '#f59e0b', glow: '#fbbf24' },
  waiting: { fill: '#f59e0b', glow: '#fbbf24' },
  done: { fill: '#0ea5e9', glow: '#38bdf8' },
  idle: { fill: '#71717a', glow: '#a1a1aa' }
}

export function stateColor(state: string) {
  return STATE_COLORS[state] ?? STATE_COLORS.idle
}

// ─── Agent Type Initials ─────────────────────────────────────────────────────
// Why: visible initials inside small agent circles provide quick identification
// of which agent type is running, fulfilling the "visible icons" requirement.
const AGENT_INITIALS: Record<string, string> = {
  claude: 'C',
  codex: 'X',
  gemini: 'G',
  opencode: 'O',
  aider: 'A',
  unknown: '?'
}

function agentInitial(type: string): string {
  return AGENT_INITIALS[type] ?? (type.charAt(0).toUpperCase() || '?')
}

// ─── Layout Helpers ──────────────────────────────────────────────────────────

/** Compute worktree circle radius that avoids overlap on the orbit ring. */
function computeWorktreeRadius(count: number): number {
  if (count <= 1) {
    return BASE_WT_R
  }
  // Why: the max radius is derived from the chord distance between adjacent
  // worktrees on the orbit. This prevents circles from overlapping as the
  // count increases.
  const maxR = ORBIT_R * Math.sin(Math.PI / count) - 2
  return Math.max(12, Math.min(BASE_WT_R, Math.floor(maxR)))
}

function computeAgentRadius(wtR: number): number {
  return Math.max(4, Math.min(BASE_AGENT_R, Math.round(wtR * 0.33)))
}

function worktreeAngle(index: number, total: number): number {
  if (total === 1) {
    return -Math.PI / 2
  }
  return -Math.PI / 2 + (2 * Math.PI * index) / total
}

function worktreePosition(angle: number): [number, number] {
  return [CX + ORBIT_R * Math.cos(angle), CY + ORBIT_R * Math.sin(angle)]
}

/** Position agents in a small orbit within their worktree circle.
 *  1 agent: centered. 2+: arranged on a mini orbit ring, creating the
 *  "concentric circles within circles" visual hierarchy. */
function agentPositions(count: number, cx: number, cy: number, wtR: number): [number, number][] {
  if (count === 0) {
    return []
  }
  if (count === 1) {
    return [[cx, cy]]
  }
  const agentOrbitR = wtR * 0.55
  return Array.from({ length: count }, (_, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / count
    return [cx + agentOrbitR * Math.cos(angle), cy + agentOrbitR * Math.sin(angle)]
  })
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}\u2026` : s
}

// ─── SVG Animations ──────────────────────────────────────────────────────────
// Why: defined as a constant string so all repo SVGs share the same keyframes.
// The `cv-` prefix prevents collisions with other page styles since inline SVG
// <style> tags leak into the global CSS scope.
const SVG_STYLES = `
  @keyframes cv-breathe {
    0%, 100% { stroke-opacity: 0.12; }
    50% { stroke-opacity: 0.45; }
  }
  .cv-breathe { animation: cv-breathe 3s ease-in-out infinite; }

  @keyframes cv-orbit-spin {
    from { stroke-dashoffset: 0; }
    to { stroke-dashoffset: -16; }
  }
  .cv-orbit-spin { animation: cv-orbit-spin 30s linear infinite; }

  @keyframes cv-pulse-ring {
    0%, 100% { stroke-opacity: 0.15; }
    50% { stroke-opacity: 0.55; }
  }
  .cv-pulse-ring { animation: cv-pulse-ring 2s ease-in-out infinite; }

  .cv-wt { cursor: pointer; }
  .cv-wt > .cv-wt-bg {
    transition: stroke-opacity 200ms ease, fill-opacity 200ms ease;
  }
  .cv-wt:hover > .cv-wt-bg {
    stroke-opacity: 0.75;
    fill-opacity: 0.28;
  }
`

// ─── RepoSystem Component ────────────────────────────────────────────────────
// Why: memoized so tooltip state changes in the parent don't re-render SVGs.
export type RepoSystemProps = {
  group: DashboardRepoGroup
  onClick: (worktreeId: string) => void
  onShowTooltip: (e: React.MouseEvent, data: Omit<TooltipData, 'x' | 'y'>) => void
  onHideTooltip: () => void
}

const RepoSystem = React.memo(function RepoSystem({
  group,
  onClick,
  onShowTooltip,
  onHideTooltip
}: RepoSystemProps) {
  const activeWorktrees = group.worktrees.filter((wt) => wt.agents.length > 0)
  const wtR = computeWorktreeRadius(activeWorktrees.length)
  const agentR = computeAgentRadius(wtR)
  const showInitials = agentR >= 6
  const totalAgents = activeWorktrees.reduce((s, w) => s + w.agents.length, 0)

  return (
    <div className="w-full max-w-[280px]">
      <svg viewBox={`0 0 ${SVG_SIZE} ${SVG_SIZE}`} className="w-full" style={{ aspectRatio: '1' }}>
        <style>{SVG_STYLES}</style>
        <defs>
          <filter id={`cv-glow-${group.repo.id}`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <radialGradient id={`cv-bg-${group.repo.id}`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor={group.repo.badgeColor} stopOpacity="0.08" />
            <stop offset="65%" stopColor={group.repo.badgeColor} stopOpacity="0.025" />
            <stop offset="100%" stopColor={group.repo.badgeColor} stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Background radial gradient — gives each repo a subtle ambient glow */}
        <circle cx={CX} cy={CY} r={REPO_RING_R + 8} fill={`url(#cv-bg-${group.repo.id})`} />

        {/* Outermost ring: repo boundary */}
        <circle
          cx={CX}
          cy={CY}
          r={REPO_RING_R}
          fill="none"
          stroke={group.repo.badgeColor}
          strokeWidth="1.5"
          strokeOpacity="0.35"
        />

        {/* Middle ring: worktree orbit (animated dashed ring) */}
        <circle
          cx={CX}
          cy={CY}
          r={ORBIT_R}
          fill="none"
          stroke="currentColor"
          strokeWidth="0.5"
          strokeOpacity="0.08"
          strokeDasharray="3 5"
          className="cv-orbit-spin"
        />

        {/* Inner decorative ring */}
        <circle
          cx={CX}
          cy={CY}
          r={INNER_DECOR_R}
          fill="none"
          stroke="currentColor"
          strokeWidth="0.5"
          strokeOpacity="0.06"
        />

        {/* Radial spokes connecting center to each worktree */}
        {activeWorktrees.map((_, i) => {
          const angle = worktreeAngle(i, activeWorktrees.length)
          const [wx, wy] = worktreePosition(angle)
          return (
            <line
              key={`spoke-${i}`}
              x1={CX}
              y1={CY}
              x2={wx}
              y2={wy}
              stroke={group.repo.badgeColor}
              strokeWidth="0.5"
              strokeOpacity="0.07"
            />
          )
        })}

        {/* Center: repo name + stats */}
        <text
          x={CX}
          y={CY - 4}
          textAnchor="middle"
          className="fill-foreground"
          style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.01em' }}
        >
          {truncate(group.repo.displayName, 16)}
        </text>
        <text
          x={CX}
          y={CY + 10}
          textAnchor="middle"
          className="fill-muted-foreground"
          style={{ fontSize: 8.5 }}
        >
          {activeWorktrees.length} worktree{activeWorktrees.length !== 1 ? 's' : ''}
          {' \u00B7 '}
          {totalAgents} agent{totalAgents !== 1 ? 's' : ''}
        </text>

        {/* Attention badge at center (if any agents need attention) */}
        {group.attentionCount > 0 && (
          <>
            <circle cx={CX + 30} cy={CY - 14} r={8} fill="#f59e0b" fillOpacity="0.2" />
            <text
              x={CX + 30}
              y={CY - 10.5}
              textAnchor="middle"
              fill="#f59e0b"
              style={{ fontSize: 9, fontWeight: 700 }}
            >
              {group.attentionCount}
            </text>
          </>
        )}

        {/* ── Worktree nodes on the orbit ring ── */}
        {activeWorktrees.map((card, i) => {
          const angle = worktreeAngle(i, activeWorktrees.length)
          const [wx, wy] = worktreePosition(angle)
          const sc = stateColor(card.dominantState)
          const aPos = agentPositions(card.agents.length, wx, wy, wtR)
          const branchName = card.worktree.branch?.replace(/^refs\/heads\//, '')

          return (
            <g
              key={card.worktree.id}
              className="cv-wt"
              onClick={() => onClick(card.worktree.id)}
              onMouseLeave={onHideTooltip}
            >
              {/* Worktree circle background */}
              <circle
                className="cv-wt-bg"
                cx={wx}
                cy={wy}
                r={wtR}
                fill={sc.fill}
                fillOpacity="0.14"
                stroke={sc.fill}
                strokeWidth="1.5"
                strokeOpacity="0.45"
              />

              {/* Glow ring: working state (gentle breathing animation) */}
              {card.dominantState === 'working' && (
                <circle
                  cx={wx}
                  cy={wy}
                  r={wtR + 4}
                  fill="none"
                  stroke={sc.glow}
                  strokeWidth="1"
                  className="cv-breathe"
                  filter={`url(#cv-glow-${group.repo.id})`}
                />
              )}

              {/* Pulse ring: blocked state (attention-drawing pulse) */}
              {card.dominantState === 'blocked' && (
                <circle
                  cx={wx}
                  cy={wy}
                  r={wtR + 5}
                  fill="none"
                  stroke={sc.glow}
                  strokeWidth="1.5"
                  className="cv-pulse-ring"
                />
              )}

              {/* Agent orbit ring (visible when 2+ agents — creates the nested
                  concentric pattern within each worktree) */}
              {card.agents.length >= 2 && (
                <circle
                  cx={wx}
                  cy={wy}
                  r={wtR * 0.55}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="0.4"
                  strokeOpacity="0.12"
                  strokeDasharray="1.5 2.5"
                />
              )}

              {/* Agent icons — each has its own hover for per-agent tooltip */}
              {card.agents.map((agent, j) => {
                const [ax, ay] = aPos[j]
                const ac = stateColor(agent.state)
                return (
                  <g
                    key={agent.paneKey}
                    onMouseMove={(e) => {
                      // Why: stopPropagation prevents the worktree-level
                      // onMouseLeave from firing when moving between agents
                      // within the same worktree circle.
                      e.stopPropagation()
                      onShowTooltip(e, {
                        agentLabel: formatAgentTypeLabel(agent.agentType),
                        state: agent.state,
                        worktreeName: card.worktree.displayName,
                        branchName
                      })
                    }}
                    onMouseLeave={onHideTooltip}
                  >
                    {/* Invisible larger hit area for easier hovering */}
                    <circle cx={ax} cy={ay} r={Math.max(agentR + 4, 12)} fill="transparent" />
                    <circle
                      cx={ax}
                      cy={ay}
                      r={agentR}
                      fill={ac.fill}
                      fillOpacity="0.9"
                      stroke={ac.glow}
                      strokeWidth="0.5"
                      strokeOpacity="0.4"
                    />
                    {showInitials && (
                      <text
                        x={ax}
                        y={ay + Math.round(agentR * 0.4)}
                        textAnchor="middle"
                        fill="white"
                        style={{
                          fontSize: Math.max(7, Math.round(agentR * 1.15)),
                          fontWeight: 700
                        }}
                      >
                        {agentInitial(agent.agentType)}
                      </text>
                    )}
                  </g>
                )
              })}

              {/* Worktree label below the circle */}
              <text
                x={wx}
                y={wy + wtR + 12}
                textAnchor="middle"
                className="fill-foreground/80"
                style={{ fontSize: 8.5, fontWeight: 500 }}
              >
                {truncate(card.worktree.displayName, 14)}
              </text>
            </g>
          )
        })}

        {/* Empty state when no worktrees have active agents */}
        {activeWorktrees.length === 0 && (
          <text
            x={CX}
            y={CY + 26}
            textAnchor="middle"
            className="fill-muted-foreground/40"
            style={{ fontSize: 9, fontStyle: 'italic' }}
          >
            No active agents
          </text>
        )}
      </svg>
    </div>
  )
})

export default RepoSystem
