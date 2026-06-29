import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../supabase'
import { getDeviceId, getStoredSlot, setStoredSlot, SLOT_NAMES } from '../gameLogic'

export default function JoinView() {
  const navigate = useNavigate()
  const [tab, setTab] = useState('join') // 'join' | 'host' | 'scoreboard'
  const [roomCode, setRoomCode] = useState('')
  const [scoreCode, setScoreCode] = useState('')
  const [totalRounds, setTotalRounds] = useState('5')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleJoin(e) {
    e.preventDefault()
    setError('')
    const code = roomCode.trim().toUpperCase()
    if (!code) return

    setLoading(true)
    try {
      // Check if game exists and is joinable
      const { data: game, error: gErr } = await supabase
        .from('games')
        .select('id, status')
        .eq('room_code', code)
        .single()

      if (gErr || !game) { setError('Room not found.'); return }
      if (game.status === 'ended') { setError('That game has already ended.'); return }

      const deviceId = getDeviceId()

      // Check if this device already has a slot
      const existing = getStoredSlot(code)
      if (existing) {
        const { data: team } = await supabase
          .from('teams')
          .select('id')
          .eq('id', existing)
          .eq('game_id', game.id)
          .single()
        if (team) { navigate(`/team/${code}`); return }
        // stale slot — fall through
      }

      // Check for an open slot
      const { data: teams } = await supabase
        .from('teams')
        .select('slot, device_id')
        .eq('game_id', game.id)

      const takenSlots = (teams || []).map(t => t.slot)
      const myTeam = (teams || []).find(t => t.device_id === deviceId)

      if (myTeam) {
        setStoredSlot(code, myTeam.id)
        navigate(`/team/${code}`)
        return
      }

      if (takenSlots.length >= 4) {
        setError('This room is full. Four teams have already joined.')
        return
      }

      // Claim the next open slot
      const nextSlot = [1, 2, 3, 4].find(s => !takenSlots.includes(s))
      const defaultName = SLOT_NAMES[nextSlot - 1]

      const { data: newTeam, error: tErr } = await supabase
        .from('teams')
        .insert({ game_id: game.id, name: defaultName, device_id: deviceId, slot: nextSlot })
        .select('id')
        .single()

      if (tErr) {
        // Could be a race condition — try to fetch again
        const { data: retryTeam } = await supabase
          .from('teams')
          .select('id')
          .eq('game_id', game.id)
          .eq('device_id', deviceId)
          .single()
        if (retryTeam) {
          setStoredSlot(code, retryTeam.id)
          navigate(`/team/${code}`)
          return
        }
        setError('Could not join — the room may be full. Try again.')
        return
      }

      setStoredSlot(code, newTeam.id)
      navigate(`/team/${code}`)
    } finally {
      setLoading(false)
    }
  }

  async function handleCreateGame(e) {
    e.preventDefault()
    setError('')
    const rounds = parseInt(totalRounds, 10)
    if (!rounds || rounds < 1 || rounds > 20) {
      setError('Rounds must be between 1 and 20.')
      return
    }
    setLoading(true)
    try {
      const { data, error: rpcErr } = await supabase.rpc('create_game', { p_total_rounds: rounds })
      if (rpcErr || !data) { setError('Failed to create game. Check your Supabase setup.'); return }
      navigate(`/host/${data}`)
    } finally {
      setLoading(false)
    }
  }

  async function handleViewScoreboard(e) {
    e.preventDefault()
    const code = scoreCode.trim().toUpperCase()
    if (!code) return
    navigate(`/scoreboard/${code}`)
  }

  return (
    <div className="center">
      <div className="card">
        <h1 className="title">Merkley Mayhem</h1>
        <p className="subtitle">Four teams. Secret actions. Chaos.</p>

        <div className="tabs">
          <button className={`tab ${tab === 'join' ? 'active' : ''}`}       onClick={() => { setTab('join');       setError('') }}>Join Team</button>
          <button className={`tab ${tab === 'host' ? 'active' : ''}`}       onClick={() => { setTab('host');       setError('') }}>Host</button>
          <button className={`tab ${tab === 'scoreboard' ? 'active' : ''}`} onClick={() => { setTab('scoreboard'); setError('') }}>Scoreboard</button>
        </div>

        {tab === 'join' && (
          <form onSubmit={handleJoin}>
            <div className="form-group">
              <div>
                <div className="field-label">Room Code</div>
                <input
                  type="text"
                  placeholder="ABC123"
                  value={roomCode}
                  onChange={e => setRoomCode(e.target.value.toUpperCase())}
                  maxLength={6}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <button type="submit" className="btn-primary" disabled={loading || !roomCode.trim()}>
                {loading ? 'Joining…' : 'Join Game'}
              </button>
            </div>
          </form>
        )}

        {tab === 'host' && (
          <form onSubmit={handleCreateGame}>
            <div className="form-group">
              <div>
                <div className="field-label">Number of Rounds</div>
                <input
                  type="text"
                  placeholder="5"
                  value={totalRounds}
                  onChange={e => setTotalRounds(e.target.value.replace(/\D/g, ''))}
                  maxLength={2}
                  autoFocus
                />
              </div>
              <button type="submit" className="btn-primary" disabled={loading}>
                {loading ? 'Creating…' : 'Create Game'}
              </button>
            </div>
            <hr className="divider" />
            <div style={{ fontSize: '0.85rem', color: 'var(--dim)', textAlign: 'center' }}>
              Already have a room? Go to <strong style={{ color: 'var(--text)' }}>/host/ROOMCODE</strong> in the URL.
            </div>
          </form>
        )}

        {tab === 'scoreboard' && (
          <form onSubmit={handleViewScoreboard}>
            <div className="form-group">
              <div>
                <div className="field-label">Room Code</div>
                <input
                  type="text"
                  placeholder="ABC123"
                  value={scoreCode}
                  onChange={e => setScoreCode(e.target.value.toUpperCase())}
                  maxLength={6}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <button type="submit" className="btn-primary" disabled={!scoreCode.trim()}>
                View Scoreboard
              </button>
            </div>
          </form>
        )}

        {error && <p className="error-msg" style={{ marginTop: '0.75rem' }}>{error}</p>}
      </div>
    </div>
  )
}
