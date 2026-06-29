import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../supabase'
import { SLOT_COLORS, SLOT_NAMES } from '../gameLogic'

export default function HostView() {
  const { roomCode } = useParams()
  const navigate = useNavigate()

  const [game, setGame]       = useState(null)
  const [teams, setTeams]     = useState([])
  const [subs, setSubs]       = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')
  const [busy, setBusy]       = useState(false)
  const [copied, setCopied]   = useState(false)

  const gameIdRef = useRef(null)

  useEffect(() => {
    if (!roomCode) return
    load()

    const channel = supabase
      .channel(`host-${roomCode}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'games',
          filter: `room_code=eq.${roomCode}` }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'teams' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'submissions' }, () => load())
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [roomCode])

  async function load() {
    if (!roomCode) return
    const { data: gameData } = await supabase
      .from('games')
      .select('*')
      .eq('room_code', roomCode)
      .single()

    if (!gameData) { setError('Game not found.'); setLoading(false); return }
    gameIdRef.current = gameData.id

    const { data: teamsData } = await supabase
      .from('teams')
      .select('*')
      .eq('game_id', gameData.id)
      .order('slot')

    const { data: subsData } = await supabase
      .from('submissions')
      .select('*')
      .eq('game_id', gameData.id)
      .eq('round_number', gameData.current_round)

    setGame(gameData)
    setTeams(teamsData || [])
    setSubs(subsData || [])
    setLoading(false)

    // Auto-resolve if all present teams are locked
    const lockedNow = (subsData || []).filter(s => s.locked).length
    const teamCountNow = (teamsData || []).length
    if (gameData.status === 'active' && teamCountNow > 0 && lockedNow === teamCountNow) {
      await clientResolveRound(gameData, teamsData || [], subsData || [])
    }
  }

  // Client-side round resolution — no SQL function required.
  // Uses optimistic locking on resolved_round to prevent double-apply.
  async function clientResolveRound(currentGame, currentTeams, currentSubs) {
    const g = currentGame || game
    const t = currentTeams || teams
    const s = currentSubs || subs
    if (!g || !gameIdRef.current || g.status !== 'active') return

    // Atomically claim this resolution: only update if not yet resolved
    const { data: claimed } = await supabase
      .from('games')
      .update({ resolved_round: g.current_round })
      .eq('id', gameIdRef.current)
      .eq('resolved_round', g.current_round - 1)
      .select('id')

    if (!claimed?.length) {
      // Already resolved by another client — just reload
      await load()
      return
    }

    // Calculate deltas
    const deltas = {}
    t.forEach(team => { deltas[team.id] = 0 })

    const givePot = s.filter(sub => sub.action === 'give').length * 4
    const giveShare = t.length > 0 ? Math.floor(givePot / t.length) : 0
    if (giveShare > 0) t.forEach(team => { deltas[team.id] += giveShare })

    s.filter(sub => sub.action === 'keep').forEach(sub => {
      if (deltas[sub.team_id] !== undefined) deltas[sub.team_id] += 2
    })

    s.filter(sub => sub.action === 'steal').forEach(sub => {
      if (deltas[sub.team_id] !== undefined) deltas[sub.team_id] += 1
      const targets = sub.targets || []
      if (targets.length === 1 && deltas[targets[0]] !== undefined) deltas[targets[0]] -= 2
      if (targets.length >= 2) {
        if (deltas[targets[0]] !== undefined) deltas[targets[0]] -= 1
        if (deltas[targets[1]] !== undefined) deltas[targets[1]] -= 1
      }
    })

    // Apply score changes
    for (const team of t) {
      const d = deltas[team.id] || 0
      await supabase.from('teams')
        .update({ score: team.score + d, last_delta: d })
        .eq('id', team.id)
    }

    // Advance or end
    const isLast = g.current_round >= g.total_rounds
    await supabase.from('games')
      .update(isLast
        ? { status: 'ended' }
        : { current_round: g.current_round + 1 })
      .eq('id', gameIdRef.current)

    await load()
  }

  async function startGame() {
    setBusy(true)
    await supabase.from('games').update({ status: 'active' }).eq('room_code', roomCode)
    await load()
    setBusy(false)
  }

  async function endGame() {
    if (!confirm('End the game now?')) return
    setBusy(true)
    await supabase.from('games').update({ status: 'ended' }).eq('room_code', roomCode)
    await load()
    setBusy(false)
  }

  async function resetGame() {
    if (!confirm('Reset the game? All scores, submissions, and teams will be cleared.')) return
    setBusy(true)
    const id = gameIdRef.current
    await supabase.from('teams').delete().eq('game_id', id)
    await supabase.from('games').update({
      status: 'waiting',
      current_round: 1,
      resolved_round: 0,
    }).eq('id', id)
    await load()
    setBusy(false)
  }

  async function addRound() {
    if (!game) return
    await supabase.from('games').update({ total_rounds: game.total_rounds + 1 }).eq('id', game.id)
    await load()
  }

  async function removeRound() {
    if (!game || game.total_rounds <= game.current_round) return
    await supabase.from('games').update({ total_rounds: game.total_rounds - 1 }).eq('id', game.id)
    await load()
  }

  async function adjustScore(teamId, delta) {
    const team = teams.find(t => t.id === teamId)
    if (!team) return
    await supabase.from('teams').update({
      score:      team.score + delta,
      last_delta: team.last_delta + delta,
    }).eq('id', teamId)
    await load()
  }

  async function addTestTeam(slot) {
    const id = gameIdRef.current
    if (!id) return
    const { error: err } = await supabase.from('teams').insert({
      game_id:   id,
      name:      `${SLOT_NAMES[slot - 1]}`,
      device_id: `host-bot-${slot}-${Date.now()}`,
      slot,
    })
    if (!err) await load()
  }

  async function clearTeamSlot(teamId) {
    if (!confirm('Remove this team from the game?')) return
    await supabase.from('teams').delete().eq('id', teamId)
    await load()
  }

  async function renameTeam(teamId, name) {
    await supabase.from('teams').update({ name }).eq('id', teamId)
    await load()
  }

  // Host submits an action on behalf of a team (for testing with fewer devices)
  async function hostSubmit(team, action) {
    const id = gameIdRef.current
    if (!id || !game) return

    // For steal, auto-target first other team
    let targets = []
    if (action === 'steal') {
      const otherTeam = teams.find(t => t.id !== team.id)
      if (otherTeam) targets = [otherTeam.id]
      else return // can't steal with no other team
    }

    const existing = subs.find(s => s.team_id === team.id)
    const payload = {
      game_id: id,
      team_id: team.id,
      round_number: game.current_round,
      action,
      targets,
      locked: true,
    }

    if (existing) {
      await supabase.from('submissions').update(payload).eq('id', existing.id)
    } else {
      await supabase.from('submissions').insert(payload)
    }
    await load()
  }

  async function forceResolve() {
    setBusy(true)
    // Fetch fresh data then resolve client-side (bypasses SQL function)
    const { data: freshGame } = await supabase.from('games').select('*').eq('room_code', roomCode).single()
    const { data: freshTeams } = await supabase.from('teams').select('*').eq('game_id', gameIdRef.current).order('slot')
    const { data: freshSubs } = await supabase.from('submissions').select('*')
      .eq('game_id', gameIdRef.current).eq('round_number', freshGame?.current_round)
    await clientResolveRound(freshGame, freshTeams || [], freshSubs || [])
    setBusy(false)
  }

  function getShareUrl(path) {
    const base = window.location.origin + window.location.pathname
    return `${base}#/${path}/${roomCode}`
  }

  async function copyUrl(url) {
    await navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  if (!roomCode) {
    return (
      <div className="center">
        <div className="card">
          <h1 className="title">Host a Game</h1>
          <p className="subtitle">Create a new room to get started.</p>
          <HostCreateForm />
        </div>
      </div>
    )
  }

  if (loading) return <div className="center"><div className="spinner" /></div>
  if (error)   return <div className="center"><p className="error-msg">{error}</p></div>
  if (!game)   return null

  const slots = [1, 2, 3, 4].map(slot => teams.find(t => t.slot === slot) || null)
  const lockedCount = subs.filter(s => s.locked).length
  const allLocked = teams.length > 0 && lockedCount === teams.length
  const statusBadgeClass = `badge badge-${game.status}`

  return (
    <div className="host-wrap">
      <div className="host-header">
        <div className="host-title">Merkley Mayhem — Host</div>
        <div className="host-meta">
          <span className={statusBadgeClass}>{game.status}</span>
          <span className="room-code-big">{roomCode}</span>
        </div>
      </div>

      {/* Links */}
      <div className="host-section">
        <div className="host-section-title">Share Links</div>
        <div className="link-row">
          <input type="text" readOnly value={getShareUrl('team')} />
          <button className="btn-secondary btn-small" onClick={() => copyUrl(getShareUrl('team'))}>
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
        <div className="link-row">
          <input type="text" readOnly value={getShareUrl('scoreboard')} />
          <button className="btn-secondary btn-small" onClick={() => copyUrl(getShareUrl('scoreboard'))}>
            Scoreboard
          </button>
        </div>
      </div>

      {/* Round info */}
      <div className="host-section">
        <div className="host-section-title">
          Round {game.current_round} of {game.total_rounds}
          {game.status === 'active' && (
            <span style={{ color: 'var(--dim)', marginLeft: '0.75rem' }}>
              ({lockedCount}/{teams.length} locked)
            </span>
          )}
        </div>
        <div className="round-controls">
          <button className="btn-secondary btn-small" onClick={removeRound}
            disabled={game.total_rounds <= game.current_round || game.status === 'ended'}>
            − Round
          </button>
          <span className="round-count">{game.total_rounds} total</span>
          <button className="btn-secondary btn-small" onClick={addRound}
            disabled={game.status === 'ended'}>
            + Round
          </button>
        </div>
      </div>

      {/* Current round submissions */}
      {game.status === 'active' && (
        <div className="host-section">
          <div className="host-section-title">Round {game.current_round} Submissions</div>
          <table className="sub-table">
            <thead>
              <tr>
                <th>Team</th>
                <th>Action</th>
                <th>Targets</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {teams.map((team, i) => {
                const sub = subs.find(s => s.team_id === team.id)
                const targetNames = (sub?.targets || [])
                  .map(tid => teams.find(t => t.id === tid)?.name || '?')
                  .join(', ')
                const color = SLOT_COLORS[team.slot - 1]

                return (
                  <tr key={team.id}>
                    <td>
                      <span style={{ color, fontWeight: 700 }}>{team.name}</span>
                    </td>
                    <td>
                      {sub?.locked ? (
                        <span className={`sub-action-${sub.action}`} style={{ textTransform: 'capitalize' }}>
                          {sub.action}
                        </span>
                      ) : (
                        <span style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap' }}>
                          <button className="btn-small" style={{ background: '#0f1f0f', color: 'var(--green)', border: '1px solid #1a3a1a', borderRadius: '5px', padding: '0.25rem 0.5rem', fontSize: '0.78rem' }}
                            onClick={() => hostSubmit(team, 'keep')}>Keep</button>
                          <button className="btn-small" style={{ background: '#1a1a08', color: 'var(--gold)', border: '1px solid #3a3a10', borderRadius: '5px', padding: '0.25rem 0.5rem', fontSize: '0.78rem' }}
                            onClick={() => hostSubmit(team, 'give')}>Give</button>
                          <button className="btn-small" style={{ background: '#1f0f0f', color: 'var(--red)', border: '1px solid #3a1010', borderRadius: '5px', padding: '0.25rem 0.5rem', fontSize: '0.78rem' }}
                            onClick={() => hostSubmit(team, 'steal')}>Steal</button>
                        </span>
                      )}
                    </td>
                    <td style={{ color: 'var(--dim)', fontSize: '0.85rem' }}>
                      {targetNames || '—'}
                    </td>
                    <td>
                      {sub?.locked
                        ? <span style={{ color: 'var(--green)', fontSize: '0.85rem' }}>Locked</span>
                        : <span className="sub-pending" style={{ fontSize: '0.85rem' }}>Pending</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {lockedCount > 0 && (
            <div style={{ marginTop: '0.75rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
              {allLocked && (
                <span style={{ color: 'var(--green)', fontSize: '0.9rem' }}>All locked</span>
              )}
              <button className="btn-secondary btn-small" onClick={forceResolve} disabled={busy}>
                Force Resolve Now
              </button>
            </div>
          )}
        </div>
      )}

      {/* Teams & scores */}
      <div className="host-section">
        <div className="host-section-title">Teams &amp; Scores</div>
        {slots.map((team, i) => (
          <TeamRow
            key={i}
            slot={i + 1}
            team={team}
            color={SLOT_COLORS[i]}
            onAdjust={(delta) => team && adjustScore(team.id, delta)}
            onClear={() => team && clearTeamSlot(team.id)}
            onRename={(name) => team && renameTeam(team.id, name)}
            onAddTest={() => addTestTeam(i + 1)}
            gameStatus={game.status}
          />
        ))}
      </div>

      {/* Game controls */}
      <div className="host-section">
        <div className="host-section-title">Game Controls</div>
        <div className="host-controls">
          {game.status === 'waiting' && (
            <button className="btn-primary" onClick={startGame} disabled={busy || teams.length < 1}>
              {busy ? 'Starting…' : 'Start Game'}
            </button>
          )}
          {game.status === 'active' && (
            <button className="btn-danger" onClick={endGame} disabled={busy}>
              End Game
            </button>
          )}
          <button className="btn-secondary" onClick={resetGame} disabled={busy}>
            Reset Game
          </button>
        </div>
        {game.status === 'waiting' && teams.length < 1 && (
          <div style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: 'var(--dim)' }}>
            Add at least one team to start.
          </div>
        )}
      </div>
    </div>
  )
}

function TeamRow({ slot, team, color, onAdjust, onClear, onRename, onAddTest, gameStatus }) {
  const [editing, setEditing] = useState(false)
  const [nameVal, setNameVal] = useState('')

  function startEdit() {
    if (!team) return
    setNameVal(team.name)
    setEditing(true)
  }

  function save() {
    if (nameVal.trim()) onRename(nameVal.trim())
    setEditing(false)
  }

  return (
    <div className="team-row">
      <div className="team-slot-dot" style={{ background: color }} />
      <div className="team-row-name">
        {!team ? (
          <span style={{ color: 'var(--dim)', fontWeight: 400 }}>Slot {slot} — Empty</span>
        ) : editing ? (
          <span style={{ display: 'flex', gap: '0.4rem' }}>
            <input
              type="text"
              value={nameVal}
              onChange={e => setNameVal(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }}
              maxLength={20}
              autoFocus
              style={{ fontSize: '0.9rem', padding: '0.25rem 0.5rem', width: '120px', color: '#e4e4f0', WebkitTextFillColor: '#e4e4f0', caretColor: '#e4e4f0' }}
            />
            <button className="btn-primary btn-small" onClick={save}>Save</button>
            <button className="btn-secondary btn-small" onClick={() => setEditing(false)}>✕</button>
          </span>
        ) : (
          <span style={{ color, cursor: 'pointer' }} onClick={startEdit} title="Click to rename">
            {team.name} ✎
          </span>
        )}
      </div>

      {team ? (
        <>
          <div className="score-adj">
            <button className="btn-secondary btn-small" onClick={() => onAdjust(-1)}>−</button>
            <span style={{ color, minWidth: '3ch', textAlign: 'center' }}>{team.score}</span>
            <button className="btn-secondary btn-small" onClick={() => onAdjust(+1)}>+</button>
          </div>
          <button className="btn-danger btn-small" onClick={onClear}
            disabled={gameStatus === 'active'} title={gameStatus === 'active' ? 'Cannot remove mid-game' : ''}>
            Remove
          </button>
        </>
      ) : (
        <button className="btn-secondary btn-small" onClick={onAddTest}
          disabled={gameStatus === 'active'}>
          + Add Team
        </button>
      )}
    </div>
  )
}

function HostCreateForm() {
  const navigate = useNavigate()
  const [rounds, setRounds] = useState('5')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function create(e) {
    e.preventDefault()
    const r = parseInt(rounds, 10)
    if (!r || r < 1 || r > 20) { setError('Rounds must be between 1 and 20.'); return }
    setLoading(true)
    const { data, error: rpcErr } = await supabase.rpc('create_game', { p_total_rounds: r })
    if (rpcErr || !data) { setError('Failed to create game.'); setLoading(false); return }
    navigate(`/host/${data}`)
  }

  return (
    <form onSubmit={create}>
      <div className="form-group">
        <div>
          <div className="field-label">Number of Rounds</div>
          <input type="text" placeholder="5" value={rounds}
            onChange={e => setRounds(e.target.value.replace(/\D/g, ''))} maxLength={2} autoFocus />
        </div>
        <button type="submit" className="btn-primary" disabled={loading}>
          {loading ? 'Creating…' : 'Create Game'}
        </button>
      </div>
      {error && <p className="error-msg">{error}</p>}
    </form>
  )
}
