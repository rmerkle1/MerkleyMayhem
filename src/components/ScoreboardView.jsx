import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../supabase'
import { SLOT_COLORS } from '../gameLogic'

export default function ScoreboardView() {
  const { roomCode } = useParams()
  const [game, setGame]   = useState(null)
  const [teams, setTeams] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    load()

    const channel = supabase
      .channel(`scoreboard-${roomCode}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'games',
          filter: `room_code=eq.${roomCode}` },
        payload => { setGame(payload.new); load() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'teams' },
        () => load())
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [roomCode])

  async function load() {
    const { data: gameData } = await supabase
      .from('games')
      .select('*')
      .eq('room_code', roomCode)
      .single()

    if (!gameData) { setError('Game not found.'); setLoading(false); return }

    const { data: teamsData } = await supabase
      .from('teams')
      .select('*')
      .eq('game_id', gameData.id)
      .order('slot')

    setGame(gameData)
    setTeams(teamsData || [])
    setLoading(false)
  }

  if (loading) return <div className="center"><div className="spinner" /></div>
  if (error)   return <div className="center"><p className="error-msg">{error}</p></div>
  if (!game)   return null

  // Fill in empty slots so layout is always 4 cards
  const slots = [1, 2, 3, 4].map(slot => teams.find(t => t.slot === slot) || null)

  return (
    <div className="scoreboard-wrap">
      <div className="scoreboard-header">
        <div className="scoreboard-title">Merkley Mayhem</div>
        <div className="scoreboard-round">
          {game.status === 'ended'
            ? 'Game Over'
            : `Round ${game.current_round} of ${game.total_rounds}`}
        </div>
        <div style={{ fontSize: '0.85rem', color: 'var(--dim)', marginTop: '0.25rem', letterSpacing: '0.08em' }}>
          {roomCode}
        </div>
      </div>

      <div className="scoreboard-grid">
        {slots.map((team, i) => {
          const slot = i + 1
          const color = SLOT_COLORS[i]

          if (!team) {
            return (
              <div key={slot} className={`score-card slot-${slot}`} style={{ opacity: 0.3 }}>
                <div className="score-team-name" style={{ color: 'var(--dim)' }}>Empty</div>
                <div className="score-value" style={{ color: 'var(--dim)' }}>—</div>
              </div>
            )
          }

          const delta = team.last_delta
          const deltaClass = delta > 0 ? 'delta-pos' : delta < 0 ? 'delta-neg' : 'delta-zero'
          const deltaStr = delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : '+0'

          return (
            <div key={team.id} className={`score-card slot-${slot}`}>
              <div className="score-team-name">{team.name}</div>
              <div className="score-value">{team.score}</div>
              <div className={`score-delta ${deltaClass}`}>
                {game.status !== 'waiting' ? deltaStr : ''}
              </div>
            </div>
          )
        })}
      </div>

      {game.status === 'ended' && (
        <div className="scoreboard-ended">
          {(() => {
            if (teams.length === 0) return null
            const maxScore = Math.max(...teams.map(t => t.score))
            const winners = teams.filter(t => t.score === maxScore)
            if (winners.length === 1) return `Winner: ${winners[0].name}!`
            return `Tied: ${winners.map(w => w.name).join(' & ')}!`
          })()}
        </div>
      )}
    </div>
  )
}
