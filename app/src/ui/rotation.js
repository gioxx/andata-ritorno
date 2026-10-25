// Pending-rotation rules for the viewer as a pure state machine, so they can be tested in node.
// state: { active: boolean, turns: 0..3 }. Effects are plain strings the viewer executes.

export const idleRotation = () => ({ active: false, turns: 0 })

/**
 * @param {{active:boolean, turns:number}} state
 * @param {'rotate'|'save'|'cancel'|'close'|'swipe'|'zoom'} event
 *   close = X / Chiudi / back / swipe-down / Escape; swipe = prev/next; zoom = pinch / double-tap
 * @returns {{state: {active:boolean, turns:number}, effects: string[]}}
 */
export function viewerAction(state, event) {
  const same = { state, effects: [] }
  switch (event) {
    case 'rotate':
      // First tap enters the pending state; zoom resets so the rotated image fits the stage.
      return { state: { active: true, turns: (state.turns + 1) % 4 }, effects: state.active ? ['turn'] : ['resetZoom', 'turn'] }
    case 'save':
      if (!state.active) return same
      // Net 0 degrees changes nothing, so nothing is written.
      return state.turns === 0
        ? { state: idleRotation(), effects: ['discard'] }
        : { state: state, effects: ['commit'] }
    case 'cancel':
      return state.active ? { state: idleRotation(), effects: ['discard'] } : same
    case 'close':
      return { state: idleRotation(), effects: state.active ? ['discard', 'close'] : ['close'] }
    case 'swipe':
    case 'zoom':
      return state.active ? same : { state, effects: [event] }
    default:
      return same
  }
}
