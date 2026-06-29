// Returns a stable device ID, persisted in localStorage
export function getDeviceId() {
  let id = localStorage.getItem('mm_device_id')
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem('mm_device_id', id)
  }
  return id
}

// Stores which slot/team this device claimed in a given room
export function getStoredSlot(roomCode) {
  return localStorage.getItem(`mm_slot_${roomCode}`)
}

export function setStoredSlot(roomCode, teamId) {
  localStorage.setItem(`mm_slot_${roomCode}`, teamId)
}

export function clearStoredSlot(roomCode) {
  localStorage.removeItem(`mm_slot_${roomCode}`)
}

// Color per slot index (0-based)
export const SLOT_COLORS = ['#7c6af7', '#4c9af7', '#4cf7a0', '#f7a04c']
export const SLOT_NAMES  = ['Team 1', 'Team 2', 'Team 3', 'Team 4']
