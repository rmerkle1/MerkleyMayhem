import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../supabase'
import { getDeviceId, getStoredSlot, clearStoredSlot, SLOT_COLORS } from '../gameLogic'

export default function TeamView() {
  const { roomCode } = useParams()
  const navigate = useNavigate()

  const [game, setGame]           = useState(null)
  const [myTeam, setMyTeam]       = useState(null)
  const [allTeams, setAllTeams]   = useState([])
  const [submission, setSubmission] = useState(null) // current round submission for my team
  const [allSubs, setAllSubs]     = useState([])     // all submissions this round
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState('')

  // Action selection state
  const [selectedAction, setSelectedAction] = useState(null)  // 'keep' | 'give' | 'steal'
  const [stealCount, setStealCount]         = useState(1)     // 1 or 2
  const [selectedTargets, setSelectedTargets] = useState([])
  const [confirming, setConfirming]         = useState(false)
  const [locking, setLocking]               = useState(false)

  // Name editing
  const [editingName, setEditingName] = useState(false)
  const [nameInput, setNameInput]     = useState('')
  const [savingName, setSavingName]   = useState(false)

  // Track last resolved round to show delta
  const [lastResolvedRound, setLastResolvedRound] = useState(null)
  const prevGameRef = useRef(null)
  const allTeamsRef = useRef([])

  const deviceId = getDeviceId()
  const myTeamId = getStoredSlot(roomCode)

  useEffect(() => {
    if (!myTeamId) {
      navigate('/')
      return
    }
    load()

    // Subscribe to real-time changes
    const channel = supabase
      .channel(`team-${roomCode}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'games',       filter: `room_code=eq.${roomCode}` }, handleGameChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'teams',       filter: `game_id=eq.${getGameId()}` }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'submissions', filter: `game_id=eq.${getGameId()}` }, handleSubChange)
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [roomCode, myTeamId])

  // We need the game_id for filters but we get it async — use a closure ref
  const gameIdRef = useRef(null)
  function getGameId() { return gameIdRef.current || 'placeholder' }

  async function load() {
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

    const me = (teamsData || []).find(t => t.id === myTeamId)
    if (!me) {
      clearStoredSlot(roomCode)
      navigate('/')
      return
    }

    const { data: subsData } = await supabase
      .from('submissions')
      .select('*')
      .eq('game_id', gameData.id)
      .eq('round_number', gameData.current_round)

    const mySub = (subsData || []).find(s => s.team_id === myTeamId) || null

    allTeamsRef.current = teamsData || []
    setGame(gameData)
    setAllTeams(teamsData || [])
    setMyTeam(me)
    setSubmission(mySub)
    setAllSubs(subsData || [])

    // If there's no locked submission yet, reset selection state
    if (!mySub) {
      setSelectedAction(null)
      setSelectedTargets([])
      setStealCount(1)
      setConfirming(false)
    }

    setLoading(false)
  }

  function handleGameChange(payload) {
    const newGame = payload.new
    if (!newGame) return

    // Detect round advance — check if resolved_round changed
    if (prevGameRef.current && prevGameRef.current.resolved_round !== newGame.resolved_round) {
      setLastResolvedRound(newGame.resolved_round)
    }
    prevGameRef.current = newGame

    setGame(newGame)
    // Reset UI for new round
    if (prevGameRef.current && prevGameRef.current.current_round !== newGame.current_round) {
      setSubmission(null)
      setAllSubs([])
      setSelectedAction(null)
      setSelectedTargets([])
      setStealCount(1)
      setConfirming(false)
    }
    // Reload teams for updated scores/deltas
    load()
  }

  async function handleSubChange() {
    if (!gameIdRef.current || !game) return
    const { data: subsData } = await supabase
      .from('submissions')
      .select('*')
      .eq('game_id', gameIdRef.current)
      .eq('round_number', game.current_round)

    setAllSubs(subsData || [])

    const mySub = (subsData || []).find(s => s.team_id === myTeamId) || null
    setSubmission(mySub)

    // If all present teams are locked, trigger resolution
    const locked = (subsData || []).filter(s => s.locked)
    const teamCount = allTeamsRef.current.length
    if (teamCount > 0 && locked.length === teamCount) {
      supabase.rpc('resolve_round', { p_room_code: roomCode }).then(() => load())
    }
  }

  async function saveName() {
    if (!nameInput.trim() || !myTeam) return
    setSavingName(true)
    await supabase.from('teams').update({ name: nameInput.trim() }).eq('id', myTeam.id)
    setEditingName(false)
    setSavingName(false)
    load()
  }

  function toggleTarget(teamId) {
    setSelectedTargets(prev => {
      if (prev.includes(teamId)) return prev.filter(id => id !== teamId)
      if (prev.length >= stealCount) return stealCount === 1 ? [teamId] : prev
      return [...prev, teamId]
    })
  }

  async function lockIn() {
    if (!selectedAction || locking) return
    if (selectedAction === 'steal' && selectedTargets.length !== stealCount) return

    setLocking(true)
    try {
      const { data: existing } = await supabase
        .from('submissions')
        .select('id, locked')
        .eq('game_id', gameIdRef.current)
        .eq('team_id', myTeamId)
        .eq('round_number', game.current_round)
        .single()

      if (existing?.locked) {
        await load()
        return
      }

      const payload = {
        game_id: gameIdRef.current,
        team_id: myTeamId,
        round_number: game.current_round,
        action: selectedAction,
        targets: selectedAction === 'steal' ? selectedTargets : [],
        locked: true,
      }

      if (existing) {
        await supabase.from('submissions').update(payload).eq('id', existing.id)
      } else {
        await supabase.from('submissions').insert(payload)
      }

      await load()
    } finally {
      setLocking(false)
      setConfirming(false)
    }
  }

  if (loading) return <div className="center"><div className="spinner" /></div>
  if (error)   return <div className="center"><p className="error-msg">{error}</p></div>
  if (!game || !myTeam) return null

  const slotColor = SLOT_COLORS[myTeam.slot - 1]
  const otherTeams = allTeams.filter(t => t.id !== myTeamId)
  const lockedCount = allSubs.filter(s => s.locked).length
  const mySubLocked = submission?.locked

  const deltaVal = myTeam.last_delta
  const deltaClass = deltaVal > 0 ? 'delta-pos' : deltaVal < 0 ? 'delta-neg' : 'delta-zero'
  const deltaStr = deltaVal > 0 ? `+${deltaVal}` : `${deltaVal}`

  // Phase: waiting for game to start
  if (game.status === 'waiting') {
    return (
      <div className="team-wrap">
        <TeamHeader myTeam={myTeam} slotColor={slotColor} roomCode={roomCode}
          editingName={editingName} setEditingName={setEditingName}
          nameInput={nameInput} setNameInput={setNameInput}
          savingName={savingName} saveName={saveName} />
        <div className="waiting-msg">
          <div className="spinner" />
          <div className="big">Waiting for host to start…</div>
          <div>Teams joined: {allTeams.length} / 4</div>
          <div style={{ color: 'var(--dim)', fontSize: '0.85rem', marginTop: '0.5rem' }}>
            Room: <strong style={{ color: 'var(--text)' }}>{roomCode}</strong>
          </div>
        </div>
      </div>
    )
  }

  // Phase: game ended
  if (game.status === 'ended') {
    return (
      <div className="team-wrap">
        <TeamHeader myTeam={myTeam} slotColor={slotColor} roomCode={roomCode}
          editingName={editingName} setEditingName={setEditingName}
          nameInput={nameInput} setNameInput={setNameInput}
          savingName={savingName} saveName={saveName} />
        <div className="game-ended-banner">
          Game Over!
          <div style={{ fontSize: '1rem', color: 'var(--dim)', fontWeight: 400, marginTop: '0.5rem' }}>
            Final score: <span style={{ color: slotColor, fontWeight: 800 }}>{myTeam.score}</span>
          </div>
        </div>
      </div>
    )
  }

  // Phase: locked — waiting for others
  if (mySubLocked) {
    return (
      <div className="team-wrap">
        <TeamHeader myTeam={myTeam} slotColor={slotColor} roomCode={roomCode}
          editingName={editingName} setEditingName={setEditingName}
          nameInput={nameInput} setNameInput={setNameInput}
          savingName={savingName} saveName={saveName} />

        {lastResolvedRound === game.current_round - 1 && lastResolvedRound !== null && (
          <div className="round-result">
            <div className="round-result-title">Round {lastResolvedRound} result</div>
            <div className={`round-result-delta ${deltaClass}`}>{deltaStr}</div>
            <div style={{ color: 'var(--dim)', fontSize: '0.85rem', marginTop: '0.25rem' }}>
              Total: {myTeam.score}
            </div>
          </div>
        )}

        <div className="waiting-msg">
          <div className="spinner" />
          <div className="big">Locked in</div>
          <div style={{ textTransform: 'capitalize' }}>
            Your choice: <strong style={{ color: actionColor(submission?.action) }}>
              {submission?.action}
            </strong>
          </div>
          <div>{lockedCount} / {allTeams.length} teams submitted</div>
        </div>
      </div>
    )
  }

  // Phase: choose action
  const readyToConfirm = selectedAction === 'keep' || selectedAction === 'give' ||
    (selectedAction === 'steal' && selectedTargets.length === stealCount)

  if (confirming) {
    return (
      <div className="team-wrap">
        <TeamHeader myTeam={myTeam} slotColor={slotColor} roomCode={roomCode}
          editingName={editingName} setEditingName={setEditingName}
          nameInput={nameInput} setNameInput={setNameInput}
          savingName={savingName} saveName={saveName} />

        <div className="action-section">
          <div style={{ flex: 1 }}>
            <div className="action-prompt" style={{ marginBottom: '1.5rem' }}>Confirm your action:</div>
            <div className={`action-btn action-${selectedAction}`} style={{ marginBottom: '1rem', cursor: 'default' }}>
              <span style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>{selectedAction}</span>
              {selectedAction === 'steal' && selectedTargets.length > 0 && (
                <span className="action-btn-sub">
                  → {selectedTargets.map(tid => allTeams.find(t => t.id === tid)?.name).join(' & ')}
                </span>
              )}
            </div>
          </div>
          <div className="lock-in-bar">
            <div className="form-group">
              <button className="btn-primary" onClick={lockIn} disabled={locking}>
                {locking ? 'Locking in…' : 'Lock In'}
              </button>
              <button className="btn-secondary" onClick={() => setConfirming(false)}>
                Go Back
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="team-wrap">
      <TeamHeader myTeam={myTeam} slotColor={slotColor} roomCode={roomCode}
        editingName={editingName} setEditingName={setEditingName}
        nameInput={nameInput} setNameInput={setNameInput}
        savingName={savingName} saveName={saveName} />

      <div style={{ marginBottom: '1.25rem' }}>
        <div className="round-label">Round {game.current_round} of {game.total_rounds}</div>
        <div style={{ color: 'var(--dim)', fontSize: '0.85rem', marginTop: '0.2rem' }}>
          Your score: <span style={{ color: slotColor, fontWeight: 800 }}>{myTeam.score}</span>
          {lastResolvedRound != null && (
            <span className={`score-delta ${deltaClass}`} style={{ marginLeft: '0.5rem' }}>
              ({deltaStr} last round)
            </span>
          )}
        </div>
      </div>

      <div className="action-section">
        <div className="action-prompt">Choose your action:</div>

        <button
          className={`action-btn action-keep ${selectedAction === 'keep' ? 'selected' : ''}`}
          onClick={() => { setSelectedAction('keep'); setSelectedTargets([]) }}
        >
          <span>Keep</span>
          <span className="action-btn-sub">+2 to you</span>
        </button>

        <button
          className={`action-btn action-give ${selectedAction === 'give' ? 'selected' : ''}`}
          onClick={() => { setSelectedAction('give'); setSelectedTargets([]) }}
        >
          <span>Give</span>
          <span className="action-btn-sub">+4 to shared pot (split 4 ways)</span>
        </button>

        <button
          className={`action-btn action-steal ${selectedAction === 'steal' ? 'selected' : ''}`}
          onClick={() => { setSelectedAction('steal'); setSelectedTargets([]) }}
        >
          <span>Steal</span>
          <span className="action-btn-sub">+1 to you, pick targets to lose points</span>
        </button>

        {selectedAction === 'steal' && (
          <div style={{ marginTop: '0.5rem' }}>
            <div className="action-prompt" style={{ fontSize: '0.9rem', marginBottom: '0.5rem' }}>
              How many targets?
            </div>
            <div className="steal-opts">
              <button
                className={`steal-opt-btn ${stealCount === 1 ? 'active' : ''}`}
                onClick={() => { setStealCount(1); setSelectedTargets([]) }}
              >
                1 target (−2)
              </button>
              <button
                className={`steal-opt-btn ${stealCount === 2 ? 'active' : ''}`}
                onClick={() => { setStealCount(2); setSelectedTargets([]) }}
              >
                2 targets (−1 each)
              </button>
            </div>
            <div className="action-prompt" style={{ fontSize: '0.9rem', margin: '0.75rem 0 0.5rem' }}>
              Select {stealCount === 1 ? 'a target' : '2 targets'}:
            </div>
            <div className="target-grid">
              {otherTeams.map(t => (
                <button
                  key={t.id}
                  className={`target-btn ${selectedTargets.includes(t.id) ? 'selected' : ''}`}
                  onClick={() => toggleTarget(t.id)}
                  disabled={!selectedTargets.includes(t.id) && selectedTargets.length >= stealCount}
                >
                  {t.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="lock-in-bar">
          <button
            className="btn-primary"
            disabled={!readyToConfirm}
            onClick={() => setConfirming(true)}
          >
            Review &amp; Lock In
          </button>
        </div>
      </div>
    </div>
  )
}

function TeamHeader({ myTeam, slotColor, roomCode, editingName, setEditingName, nameInput, setNameInput, savingName, saveName }) {
  return (
    <div className="team-header">
      <div>
        {editingName ? (
          <div className="name-edit-row">
            <input
              type="text"
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setEditingName(false) }}
              maxLength={20}
              autoFocus
              style={{ fontSize: '1rem', padding: '0.4rem 0.6rem', color: 'var(--text)', WebkitTextFillColor: 'var(--text)' }}
            />
            <button className="btn-primary btn-small" onClick={saveName} disabled={savingName}>
              {savingName ? '…' : 'Save'}
            </button>
            <button className="btn-secondary btn-small" onClick={() => setEditingName(false)}>✕</button>
          </div>
        ) : (
          <div
            className="team-name-display"
            style={{ color: slotColor, cursor: 'pointer' }}
            onClick={() => { setNameInput(myTeam.name); setEditingName(true) }}
            title="Tap to rename"
          >
            {myTeam.name} ✎
          </div>
        )}
        <div className="room-code-display">Room {roomCode}</div>
      </div>
    </div>
  )
}

function actionColor(action) {
  if (action === 'keep')  return 'var(--green)'
  if (action === 'give')  return 'var(--gold)'
  if (action === 'steal') return 'var(--red)'
  return 'var(--text)'
}
