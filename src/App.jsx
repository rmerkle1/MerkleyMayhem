import { HashRouter, Routes, Route } from 'react-router-dom'
import JoinView from './components/JoinView'
import TeamView from './components/TeamView'
import ScoreboardView from './components/ScoreboardView'
import HostView from './components/HostView'

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/"                       element={<JoinView />} />
        <Route path="/team/:roomCode"         element={<TeamView />} />
        <Route path="/scoreboard/:roomCode"   element={<ScoreboardView />} />
        <Route path="/host"                   element={<HostView />} />
        <Route path="/host/:roomCode"         element={<HostView />} />
      </Routes>
    </HashRouter>
  )
}
